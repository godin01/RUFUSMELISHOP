# Backend RUFUS — Mercado Livre + Shopee

Servidor que autentica com as APIs oficiais de vendedor do Mercado Livre e da
Shopee (OAuth) e devolve vendas recentes já com a taxa real cobrada em cada
uma — sem precisar exportar planilha nem calcular na mão. Mesmo padrão do
`backend-bling-ga-produtos_5atual` que vocês já usam.

## 1. Mercado Livre — criar a aplicação no DevCenter

1. Acesse [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br)
   e faça login com a conta de vendedor (ou uma conta dedicada, se preferir).
2. Vá em **DevCenter > Criar uma aplicação**.
3. Preencha:
   - **Nome**: precisa ser único (ex: "RUFUS Ga Produtos").
   - **Nome curto**: usado na URL da aplicação.
   - **Descrição**: até 150 caracteres.
   - **URLs de redirecionamento**: você ainda não tem a URL final — volte
     aqui depois do deploy (passo 4) pra preencher, ex:
     `https://rufus-backend.onrender.com/auth/ml/callback`.
   - **Escopos**: marque pelo menos `read` (leitura de pedidos e itens).
4. Salve e copie o **Client ID** e o **Client Secret**.

Fontes: [Crie uma aplicação no Mercado Livre](https://developers.mercadolivre.com.br/pt_br/crie-uma-aplicacao-no-mercado-livre), [Register your application](https://developers.mercadolivre.com.br/en_us/register-your-application).

## 2. Shopee — criar o app no Open Platform

1. Acesse [open.shopee.com](https://open.shopee.com) e crie uma conta de
   desenvolvedor/parceiro (pede CNPJ da loja).
2. Crie um app novo em modo **Live** (não "Test" — o modo teste não acessa
   sua loja real).
3. Preencha a **URL de redirecionamento**, ex:
   `https://rufus-backend.onrender.com/auth/shopee/callback`.
4. Copie o **Partner ID** e a **Partner Key** — a Partner Key nunca deve
   aparecer no frontend, só neste backend.

> A Shopee costuma levar alguns dias pra aprovar o app em modo Live —
> diferente do Mercado Livre, que libera na hora.

## 3. Banco no Supabase

Pode reaproveitar o mesmo projeto Supabase do backend do Bling — só rodar
este SQL a mais no **SQL Editor**:

```sql
create table ml_tokens (
  id integer primary key,
  user_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  expires_at bigint not null
);

create table shopee_tokens (
  shop_id bigint primary key,
  access_token text not null,
  refresh_token text not null,
  expires_at bigint not null
);
```

## 4. Preparar e rodar

```bash
cd backend
npm install
cp .env.example .env
# edite o .env com as credenciais dos passos 1, 2 e 3
```

## 5. Deploy gratuito no Render

Mesmo processo do backend do Bling:

1. Suba esta pasta (`RUFUS/backend`) para um repositório no GitHub.
2. No Render, **New > Web Service**, conecte o repositório.
3. **Build command**: `npm install` · **Start command**: `npm start` · **Plan**: Free.
4. Em **Environment**, adicione todas as variáveis do `.env.example`.
5. Deploy. Você terá uma URL tipo `https://rufus-backend.onrender.com`.
6. Volte ao DevCenter do Mercado Livre e ao Open Platform da Shopee e cole
   as URLs de callback finais (passos 1 e 2).

## 6. Conectar as contas (uma vez cada)

Acesse no navegador:

```
https://rufus-backend.onrender.com/auth/ml/login
https://rufus-backend.onrender.com/auth/shopee/login
```

Faça login/autorize em cada plataforma. Os tokens ficam salvos no Supabase
— não precisa reconectar toda vez que o Render "dorme" (plano free).

## 7. Consultar as vendas

```
GET /api/ml/vendas
GET /api/shopee/vendas?shop_id=SEU_SHOP_ID
```

Cada venda vem com o valor total, a comissão real cobrada pela plataforma
e o valor líquido que efetivamente cai na conta — os mesmos números que
hoje só aparecem no extrato/repasse de cada marketplace.

## Limitações

- Isso mostra dados **da sua própria conta**, não de concorrentes — nenhuma
  das duas plataformas expõe isso por API oficial (só o painel de
  concorrência da extensão RUFUS, que lê a página que você está vendo).
- O endpoint da Shopee busca só pedidos `COMPLETED` dos últimos 7 dias por
  padrão — ajuste `time_from`/`time_to` em `server.js` se precisar de mais.
- Ainda não existe uma tela no RUFUS consumindo esses endpoints — por
  enquanto são só APIs cruas (JSON). Se quiser, o próximo passo natural é
  uma aba "Minhas Vendas" no `index.html` puxando daqui.
