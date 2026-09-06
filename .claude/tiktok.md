# Integração — TikTok Shop

> Status atual (06/09/2026): **Fase 1 (só vendas) construída, ainda não em produção.** Objetivo do usuário: "saber as vendas" — não é réplica da Shopee (chat/catálogo/promoções/financeiro ficam de fora por decisão explícita, ver "O que NÃO foi feito nesta fase"). Código segue o mesmo molde da Shopee (cliente + polling + webhook + rotas + worker), mas **nenhuma chamada real foi testada ainda** — o usuário não tem app criado no Partner Center. Ao tentar o cadastro de "Seller Developer" (autoatendimento, cria app pra própria loja), o TikTok recusou: "só vendedores com Account Manager (AM) atribuído podem se registrar". Ver "Bloqueio de cadastro" abaixo antes de ir a produção.

## Bloqueio de cadastro (06/09/2026, ainda sem solução confirmada)

O Partner Center tem dois tipos de conta no cadastro:
- **Seller Developer** — o próprio vendedor cria o app pra loja dele. **Bloqueado** para esta conta: exige AM (Account Manager) já atribuído pelo TikTok.
- **Partner/Developer** — cria um app não vinculado a nenhuma loja específica, passa por App Review, depois autoriza pra uma loja qualquer (inclusive a própria) via OAuth normal — **não** parece exigir AM.

Caminhos a tentar (usuário está avaliando):
1. Cadastro como **Partner/Developer** em vez de Seller Developer — app fica em revisão antes de poder pedir escopo de Pedidos em produção, mas não depende de AM.
2. **Conseguir um AM** — link "Aprenda como conseguir um AM" no próprio erro; como a loja já vende de verdade no TikTok Shop Brasil, pode qualificar por volume, mas depende de contato com o suporte do Seller Center, sem prazo garantido.

Nenhum dos dois caminhos muda o código já construído — os dois terminam em App Key/App Secret + OAuth, mesmo contrato que `tiktokClient.js` já implementa.

## O que já existe

- **`server/src/marketplaces/tiktok/tiktokClient.js`** — cliente real: `sign()` (HMAC-SHA256 de request de negócio — DIFERENTE da assinatura de webhook), `getAuthorizationUrl`/`exchangeCodeForToken` (funções app-level, exportadas separadas da classe, mesmo padrão de `shopeeClient.js`), `refreshAccessToken`/`getOrder`/`listRecentOrders` (contrato `MarketplaceClient`, mesmo de `amazonClient.js`/`shopeeClient.js`).
- **`server/src/marketplaces/tiktok/TiktokPollingEventSource.js`** — implementação real do `EventSource`: polling a cada 15 min (`TIKTOK_POLL_INTERVAL_MS`), cursor em `marketplace_sync_state`, renovação proativa de token com CAS (margem de 10 min antes de expirar — mesmo padrão de `decisions.md`).
- **`server/src/routes/tiktokAuth.js`** (montada em `/auth/tiktok`) — fluxo OAuth: `GET /config` (diagnóstico), `GET /login` (redireciona pro TikTok), `GET /callback` (troca `code` por tokens, cria/atualiza a linha em `stores`). Ver `api.md`.
- **`server/src/routes/tiktokWebhook.js`** (montada em `/webhooks/tiktok`) — receptor de push, isolado do gateway ML e do webhook Shopee. Ver seção própria abaixo.
- **`server/src/routes/tiktok.js`** (montada em `/api/tiktok`) — dashboard mínimo: `GET /kpis`, `GET /pedidos`, `GET /status`. Deliberadamente **sem** `/produtos`, `/lojas`, `/chat`, `/financeiro` — fora do escopo da Fase 1.
- **`server/src/marketplaceEventWorker.js`** — ganhou um terceiro `Worker`/fila (`marketplace-events-tiktok`) e handler (`handleTiktokOrderEvent`), paralelo ao da Amazon/Shopee, sem tocar neles. Ver `workers.md`.
- **Migration v94** (`server/src/db/migrate-v94.sql`) — habilita `marketplaces.TIKTOK` (`enabled=true`, `api_type='polling'`), `stores.tiktok_shop_id`/`stores.tiktok_shop_cipher` (índice único parcial no shop_id), tabela `tiktok_order_data`. Ver `database.md`. **Testada contra Postgres real** (cadeia completa `schema.sql` → `migrate-v94.sql`, 91 migrations, 0 erro; reexecução confirmada idempotente; queries das 3 rotas de dashboard simuladas com dados sintéticos e conferidas).
- `env.tiktok` em `config/env.js` (`appKey`, `appSecret`, `redirectUri`, `webhookVerify`).
- **`pages/dashboard-tiktok.html`** + **`js/layout-tiktok.js`** — dashboard próprio (KPIs vendas/pedidos hoje e total + tabela de últimos pedidos + card de status da integração), sidebar/topbar isolados (cor de marca `#ff0050`, ícone `fa-tiktok`). Sem tela de produtos/catálogo (Fase 1). Métodos em `js/db.js`: `getTiktokKpis()`, `getTiktokPedidos()`, `getTiktokStatus()`.
- Links cruzados no `mkt-switcher-compact` (ML/Amazon/Shopee/TikTok Shop) adicionados nos 4 layouts (`js/layout.js`, `layout-amazon.js`, `layout-shopee.js`, `layout-tiktok.js`).

## Terminologia e endpoints confirmados (busca web — `partner.tiktokshop.com` está bloqueado pelo proxy de saída deste ambiente, não foi possível ler a doc oficial direto)

- OAuth usa **App Key/App Secret** (não Client ID/Secret) e `grant_type=authorized_code` (grafia não-padrão, propositalmente diferente de `authorization_code` — não "corrigir").
- Troca de código: `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key=&app_secret=&auth_code=&grant_type=authorized_code`.
- Refresh: `GET https://auth.tiktok-shops.com/api/v2/token/refresh?...&grant_type=refresh_token`. Expiração padrão do access_token ~7 dias.
- Shop API: base `https://open-api.tiktokglobalshop.com`, versionada por segmento de data no path (`202309`).
- Assinatura de **request de negócio** (Shop API): `sign = HMAC-SHA256(app_secret, app_secret + path + query_ordenada + body + app_secret)`, hex minúsculo, no parâmetro `sign` da query string — **diferente** da assinatura de webhook.
- Assinatura de **webhook**: `HMAC-SHA256(app_secret, app_key + raw_body)`, hex minúsculo, no header `Authorization` **sem** prefixo "Bearer". Sem timestamp — sem proteção a replay; idempotência via `tts_notification_id` (dedupe por `jobId` no BullMQ, mesmo padrão da Shopee).
- Busca de pedidos: `POST /order/202309/orders/search` (recebe filtro no BODY — diferente da Shopee, que usa GET+query).
- Cadastro de webhook: `POST /event/202309/webhooks`. Evento confirmado: `ORDER_STATUS_CHANGE`. Payload de exemplo: `{type, tts_notification_id, shop_id, timestamp, data:{order_id, order_status}}`.

## O que falta confirmar

Itens abaixo estão marcados com `⚠️` no código (`tiktokClient.js`, `marketplaceEventWorker.js`) — **não inventar valores além do documentado**, mesma disciplina já usada pra Shopee (ver "O que NÃO fazer"):

1. **URL de autorização exata para Custom App** — `getAuthorizationUrl()` monta `https://services.tiktokshop.com/open/authorize?service_id=&redirect_uri=`, mas Custom Apps costumam ter um link pronto direto na tela do app no Partner Center. Comparar os dois antes de usar em produção.
2. **Nomes exatos dos campos da resposta de pedido** (`/order/202309/orders/search` e `/order/202309/orders/{id}`) — o handler assume `order_id`/`order_status`/`payment.total_amount`/`create_time`, prováveis pelo padrão do resto da API, mas não confirmados contra uma resposta real.
3. **Códigos de erro de "token inválido/expirado"** — `_call()` assume `[105002, 105003, 36004001]`, não confirmados contra um erro real do Shop API.
4. **Chave de assinatura do webhook** — assumido que é o mesmo `app_secret` do OAuth; a Shopee usa uma "Chave de parceiro Live Push" **separada** da partner_key — não está confirmado se o TikTok Shop também separa as duas.
5. **`page_size`/`sort_field` de `/orders/search`** — valores usados (`page_size=50`) são um chute conservador, não confirmados contra a doc.

Cada um só pode ser fechado com o app criado e uma primeira chamada real — não há como testar contra a API viva a partir deste ambiente (proxy de saída bloqueia `partner.tiktokshop.com`/`open-api.tiktokglobalshop.com`) nem sem credenciais do usuário.

## Webhook — implementado, sem handshake

Receptor **isolado** de tudo o mais: `server/src/routes/tiktokWebhook.js`, montado em **`/webhooks/tiktok`**, **antes** do `express.json()` global (`express.raw()` — a assinatura precisa do corpo cru). Fluxo: responde `200` na hora → valida assinatura (`Authorization` header, sem prefixo) → enfileira o **mesmo evento padronizado do polling** (`marketplace-events-tiktok`, `jobId` `TIKTOK:ORDER_UPDATED:{storeId}-{orderId}`) → `handleTiktokOrderEvent` processa igual, em tempo real. Diferente da Shopee, a documentação pública do TikTok não descreve um passo de handshake/echo ao cadastrar a URL — só um `GET` de teste de conectividade (implementado, responde 200). Se o console do TikTok exigir um handshake real na hora de cadastrar, isso vai aparecer no 1º teste e precisa ser adicionado.

- **Configuração** (usuário, quando o app existir): no Partner Center → Webhooks, cadastrar a URL `https://multimixvendas.duckdns.org/webhooks/tiktok` e habilitar `ORDER_STATUS_CHANGE`.
- **Escape hatch**: `TIKTOK_WEBHOOK_VERIFY=false` desliga a validação de assinatura pro 1º teste (mesmo padrão `SHOPEE_WEBHOOK_VERIFY`).
- **Dedup com o polling**: mesmo `jobId` → BullMQ ignora duplicata. Polling continua ligado como rede de segurança (mesma decisão da Shopee — webhooks podem se perder).

## Dashboard dedicado (`pages/dashboard-tiktok.html`)

KPIs (vendas/pedidos hoje e total), tabela de últimos 200 pedidos, card de status (última sincronização, contas conectadas). Sem produtos/catálogo — Fase 1 é só vendas. Ver `frontend.md` pro contrato geral de página nova.

**Estado atual da página: "em construção"** (classe `.em-construcao` de `css/style.css`, mesmo padrão já usado nos módulos ainda não implementados). Enquanto não existe conta TikTok Shop autorizada (sem app no Partner Center, ver "Bloqueio de cadastro"), mostrar KPIs zerados seria enganoso — a página avisa que a integração está pronta no backend mas falta autorizar a conta. Todo o HTML/JS de KPIs/tabela/status (o dashboard real) continua no arquivo, **comentado** (bloco HTML dentro de `<!-- -->` + os `<script>` de `db.js`/`tableExport.js`/`websocket.js` e a lógica de `loadKpis`/`loadPedidos`/`loadStatus`) — descomentar os dois blocos juntos assim que `/auth/tiktok/login` autorizar a 1ª conta real.

## O que NÃO foi feito nesta fase (por decisão explícita do usuário — "saber as vendas")

Ao contrário da Shopee (que cresceu de "só pedidos" até chat/catálogo/promoções/financeiro/score/precificador ao longo de várias fases), o TikTok Shop **fica só em vendas** por enquanto:
- Sem catálogo de produtos (Product API) — sem tela de anúncios/estoque/preço.
- Sem chat (Message API).
- Sem promoções/cupons.
- Sem financeiro/repasse (Finance API) — nenhuma tela de conciliação.
- Sem devoluções (Returns API).
- Sem papel de login restrito equivalente ao `shopee-demo` — não há revisor externo do TikTok pra atender ainda.

Se o usuário pedir qualquer um desses depois, seguir o mesmo padrão incremental já usado na Shopee (uma fase de cada vez, com o contrato de campo confirmado antes de codificar).

## O que NÃO fazer

- Não adicionar um cliente TikTok direto no frontend — toda leitura passa por `/api/tiktok/*` (mesma regra de `architecture.md`).
- Não "adivinhar" nomes de campo/endpoint além do que está na seção "Terminologia e endpoints confirmados" — usar os itens de "O que falta confirmar" como checklist antes de confiar em qualquer dado do TikTok em produção.
- Nunca colar `App Secret`/tokens em chat — só em `server/.env`.
- Não tentar registrar como "Seller Developer" de novo sem primeiro tentar "Partner/Developer" ou conseguir um AM — ver "Bloqueio de cadastro".
