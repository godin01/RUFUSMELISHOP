/**
 * Backend de integração com as APIs oficiais do Mercado Livre e da Shopee.
 * ------------------------------------------------------------------------
 * Guarda os tokens de acesso no servidor (nunca no navegador) e expõe
 * endpoints que devolvem vendas recentes já com a taxa real cobrada por
 * venda — mesmo padrão do backend do Bling (backend-bling-ga-produtos_5atual).
 *
 * Requer Node.js 18+ (usa fetch nativo).
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

const {
  ML_CLIENT_ID,
  ML_CLIENT_SECRET,
  ML_REDIRECT_URI,
  SHOPEE_PARTNER_ID,
  SHOPEE_PARTNER_KEY,
  SHOPEE_REDIRECT_URI,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  DASHBOARD_PASSWORD,
  DASHBOARD_ORIGINS,
  PORT = 3000,
} = process.env;

const origensPermitidas = (DASHBOARD_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origensPermitidas.length === 0 || origensPermitidas.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Origem não permitida por CORS'));
  },
}));
app.use(express.json());

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------------------------------------------------------------------
// Login simples do painel (mesma ideia do backend do Bling) — protege os
// endpoints /api/* atrás de uma senha única, sem precisar de banco de sessão.
// ---------------------------------------------------------------------
function checarSenha(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next(); // login desativado se a senha não estiver configurada
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${DASHBOARD_PASSWORD}`) return next();
  res.status(401).json({ erro: 'Não autorizado' });
}

// =======================================================================
// MERCADO LIVRE — OAuth 2.0 padrão
// Docs: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
// =======================================================================
const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const ML_API = 'https://api.mercadolibre.com';

async function salvarTokenML(tokens, userId) {
  const { error } = await supabase.from('ml_tokens').upsert({
    id: 1,
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  });
  if (error) throw error;
}

async function lerTokenML() {
  const { data, error } = await supabase.from('ml_tokens').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data;
}

async function getAccessTokenML() {
  const saved = await lerTokenML();
  if (!saved) throw new Error('Conta do Mercado Livre ainda não conectada — acesse /auth/ml/login');
  if (Date.now() < saved.expires_at - 60_000) return saved.access_token;

  // token expirado (dura ~6h) — renova com o refresh_token
  const resp = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: saved.refresh_token,
    }),
  });
  const tokens = await resp.json();
  if (!resp.ok) throw new Error('Falha ao renovar token do ML: ' + JSON.stringify(tokens));
  await salvarTokenML(tokens, saved.user_id);
  return tokens.access_token;
}

app.get('/auth/ml/login', (req, res) => {
  const url = new URL(ML_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', ML_CLIENT_ID);
  url.searchParams.set('redirect_uri', ML_REDIRECT_URI);
  res.redirect(url.toString());
});

app.get('/auth/ml/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Faltou o parâmetro "code".');
  try {
    const resp = await fetch(ML_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: ML_REDIRECT_URI,
      }),
    });
    const tokens = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(tokens));
    await salvarTokenML(tokens, tokens.user_id);
    res.send('Conta do Mercado Livre conectada com sucesso. Pode fechar esta aba.');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erro ao conectar com o Mercado Livre: ' + e.message);
  }
});

// Vendas recentes com a comissão real cobrada em cada uma (order.payments[].marketplace_fee)
app.get('/api/ml/vendas', checarSenha, async (req, res) => {
  try {
    const accessToken = await getAccessTokenML();
    const { data: tokenRow } = await supabase.from('ml_tokens').select('user_id').eq('id', 1).maybeSingle();

    const buscaResp = await fetch(
      `${ML_API}/orders/search?seller=${tokenRow.user_id}&order.status=paid&sort=date_desc&limit=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const busca = await buscaResp.json();
    if (!buscaResp.ok) throw new Error(JSON.stringify(busca));

    const vendas = await Promise.all(
      (busca.results || []).map(async (pedido) => {
        const detalheResp = await fetch(`${ML_API}/orders/${pedido.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const detalhe = await detalheResp.json();
        const pagamento = (detalhe.payments || [])[0] || {};
        return {
          pedido_id: detalhe.id,
          data: detalhe.date_created,
          produto: (detalhe.order_items || [])[0]?.item?.title,
          valor_total: detalhe.total_amount,
          comissao_ml: pagamento.marketplace_fee ?? null,
          valor_liquido: pagamento.marketplace_fee != null ? detalhe.total_amount - pagamento.marketplace_fee : null,
        };
      })
    );

    res.json({ vendas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// =======================================================================
// SHOPEE — Open Platform v2. Cada chamada é assinada com HMAC-SHA256
// (partner_key nunca sai do servidor). Docs: https://open.shopee.com/developer-guide
// =======================================================================
const SHOPEE_BASE = 'https://partner.shopeemobile.com';

function assinarShopee(path, extra = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${SHOPEE_PARTNER_ID}${path}${timestamp}${extra}`;
  const sign = crypto.createHmac('sha256', SHOPEE_PARTNER_KEY).update(baseString).digest('hex');
  return { timestamp, sign };
}

async function salvarTokenShopee(shopId, tokens) {
  const { error } = await supabase.from('shopee_tokens').upsert({
    shop_id: shopId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expire_in * 1000,
  });
  if (error) throw error;
}

async function lerTokenShopee(shopId) {
  const { data, error } = await supabase.from('shopee_tokens').select('*').eq('shop_id', shopId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getAccessTokenShopee(shopId) {
  const saved = await lerTokenShopee(shopId);
  if (!saved) throw new Error('Essa loja da Shopee ainda não foi conectada — acesse /auth/shopee/login');
  if (Date.now() < saved.expires_at - 60_000) return saved.access_token;

  const path = '/api/v2/auth/access_token/get';
  const { timestamp, sign } = assinarShopee(path);
  const resp = await fetch(`${SHOPEE_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: saved.refresh_token, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
  });
  const tokens = await resp.json();
  if (!resp.ok || tokens.error) throw new Error('Falha ao renovar token da Shopee: ' + JSON.stringify(tokens));
  await salvarTokenShopee(shopId, tokens);
  return tokens.access_token;
}

app.get('/auth/shopee/login', (req, res) => {
  const path = '/api/v2/shop/auth_partner';
  const { timestamp, sign } = assinarShopee(path);
  const url = `${SHOPEE_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(SHOPEE_REDIRECT_URI)}`;
  res.redirect(url);
});

app.get('/auth/shopee/callback', async (req, res) => {
  const { code, shop_id: shopId } = req.query;
  if (!code || !shopId) return res.status(400).send('Faltou "code" ou "shop_id".');
  try {
    const path = '/api/v2/auth/token/get';
    const { timestamp, sign } = assinarShopee(path);
    const resp = await fetch(`${SHOPEE_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
    });
    const tokens = await resp.json();
    if (!resp.ok || tokens.error) throw new Error(JSON.stringify(tokens));
    await salvarTokenShopee(shopId, tokens);
    res.send('Loja da Shopee conectada com sucesso. Pode fechar esta aba.');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erro ao conectar com a Shopee: ' + e.message);
  }
});

// Vendas recentes com o valor líquido real (get_escrow_detail traz a
// decomposição completa de taxas que a Shopee já aplicou no repasse)
app.get('/api/shopee/vendas', checarSenha, async (req, res) => {
  const { shop_id: shopId } = req.query;
  if (!shopId) return res.status(400).json({ erro: 'Informe ?shop_id= na URL (uma conta pode ter mais de uma loja).' });
  try {
    const accessToken = await getAccessTokenShopee(shopId);
    const agora = Math.floor(Date.now() / 1000);
    const seteDiasAtras = agora - 7 * 24 * 60 * 60;

    const listaPath = '/api/v2/order/get_order_list';
    const { timestamp: t1, sign: s1 } = assinarShopee(listaPath, `${accessToken}${shopId}`);
    const listaResp = await fetch(
      `${SHOPEE_BASE}${listaPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${t1}&access_token=${accessToken}&shop_id=${shopId}&sign=${s1}` +
      `&time_range_field=create_time&time_from=${seteDiasAtras}&time_to=${agora}&page_size=50&order_status=COMPLETED`
    );
    const lista = await listaResp.json();
    if (lista.error) throw new Error(JSON.stringify(lista));

    const pedidos = (lista.response?.order_list || []);
    const vendas = await Promise.all(
      pedidos.map(async ({ order_sn }) => {
        const escrowPath = '/api/v2/payment/get_escrow_detail';
        const { timestamp: t2, sign: s2 } = assinarShopee(escrowPath, `${accessToken}${shopId}`);
        const escrowResp = await fetch(
          `${SHOPEE_BASE}${escrowPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${t2}&access_token=${accessToken}&shop_id=${shopId}&sign=${s2}&order_sn=${order_sn}`
        );
        const escrow = await escrowResp.json();
        const d = escrow.response?.order_income || {};
        return {
          pedido_sn: order_sn,
          valor_total: d.order_selling_price,
          comissao_shopee: d.commission_fee,
          taxa_servico: d.service_fee,
          valor_liquido: d.escrow_amount,
        };
      })
    );

    res.json({ vendas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

app.listen(PORT, () => console.log(`RUFUS backend rodando na porta ${PORT}`));
