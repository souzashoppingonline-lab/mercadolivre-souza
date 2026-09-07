# Integração — TikTok Shop

> Status atual (07/09/2026): **Fase 1 (só vendas) construída, ainda não em produção.** Objetivo do usuário: "saber as vendas" — não é réplica da Shopee (chat/catálogo/promoções/financeiro ficam de fora por decisão explícita, ver "O que NÃO foi feito nesta fase"). Código segue o mesmo molde da Shopee (cliente + polling + webhook + rotas + worker), mas **nenhuma chamada real foi testada ainda** — falta o app aprovado no Partner Center. Uma rodada extensa de estudo da doc oficial (07/09) corrigiu vários pontos que tinham sido inferidos só de um SDK de terceiro — ver "Terminologia e endpoints" abaixo, agora majoritariamente 🟢 confirmado pela doc real, não mais só por SDK.

## Nosso perfil de desenvolvedor (confirmado pela doc oficial)

A TikTok Shop define 3 tipos de desenvolvedor ("Get started overview"): **eCommerce platform plugin/connector** (app público, não guarda credencial OAuth), **eCommerce system integrator/SaaS** (app público, acesso a muitos sellers), e **TikTok Shop seller developer** (Custom App, credenciais próprias, só os dados da própria loja). **Somos o 3º tipo** — exatamente o perfil mais simples, sem revisão pública nem listagem no App Store.

O token de acesso traz um campo `user_type`: `0`=Seller, `1`=Creator, `3`=Partner. Como somos "seller developer", sempre esperamos `user_type=0` — `tiktokAuth.js` já loga um warning se vier outro valor (sinal de app configurado errado no Partner Center).

## Bloqueio de cadastro (06/09/2026 — status pode já ter mudado, ver nota)

Ao tentar o cadastro de "Seller Developer" (autoatendimento), o TikTok recusou: "só vendedores com Account Manager (AM) atribuído podem se registrar". Dois caminhos discutidos: (1) registrar como **Partner/Developer** em vez de Seller Developer, (2) conseguir um AM (o usuário já vende de verdade no Brasil, pode qualificar por volume).

**Pista nova**: o usuário chegou a mostrar o "Questionário sobre segurança e privacidade de dados" do Partner Center (07/09) — essa etapa só existe depois que um app já foi criado ("App launch overview" confirma que é a etapa de **revisão de compliance/legal**, posterior à criação do app). Ou seja, é provável que o bloqueio de AM já tenha sido superado de alguma forma (não confirmado qual caminho) — **perguntar ao usuário antes de assumir** que ainda está bloqueado.

Também confirmado ("Product API overview" FAQ): sellers novos entram em **período de probation** (limite de 100-200 pedidos/dia conforme pessoa física/jurídica, 100 uploads de produto/dia) até "graduar" — e é o **Account Manager** quem libera isso. Pode ser o mesmo AM do bloqueio de cadastro, ou um conceito relacionado mas distinto (não confirmado se é a mesma pessoa/processo).

Nenhum dos caminhos muda o código já construído — todos terminam em App Key/App Secret + OAuth, mesmo contrato que `tiktokClient.js` já implementa.

## O que já existe

- **`server/src/marketplaces/tiktok/tiktokClient.js`** — cliente real: `sign()` (HMAC-SHA256 de request de negócio — DIFERENTE da assinatura de webhook), `getAuthorizationUrl`/`exchangeCodeForToken`/`getAuthorizedShops()` (funções/métodos app-level, mesmo padrão de `shopeeClient.js`), `refreshAccessToken`/`getOrder`/`listRecentOrders` (contrato `MarketplaceClient`, mesmo de `amazonClient.js`/`shopeeClient.js`).
- **`server/src/marketplaces/tiktok/TiktokPollingEventSource.js`** — polling a cada 15 min (`TIKTOK_POLL_INTERVAL_MS`), cursor em `marketplace_sync_state`, renovação proativa de token com CAS.
- **`server/src/routes/tiktokAuth.js`** (montada em `/auth/tiktok`) — fluxo OAuth: `GET /config`, `GET /login`, `GET /callback` (troca code→token, chama `getAuthorizedShops()`, valida `user_type`, cria/atualiza a linha em `stores`). Ver `api.md`.
- **`server/src/routes/tiktokWebhook.js`** (montada em `/webhooks/tiktok`) — receptor de push. Ver seção própria abaixo.
- **`server/src/routes/tiktok.js`** (montada em `/api/tiktok`) — dashboard mínimo: `GET /kpis`, `GET /pedidos`, `GET /status`. Deliberadamente **sem** `/produtos`, `/lojas`, `/chat`, `/financeiro`.
- **`server/src/marketplaceEventWorker.js`** — fila `marketplace-events-tiktok` + handler `handleTiktokOrderEvent`; `mapTiktokStatus()` cobre os 9 status reais (ver enum abaixo). Ver `workers.md`.
- **Migration v94** — habilita `marketplaces.TIKTOK`, `stores.tiktok_shop_id`/`tiktok_shop_cipher`, tabela `tiktok_order_data`. **Testada contra Postgres real**. Ver `database.md`.
- `env.tiktok` em `config/env.js` (`appKey`, `appSecret`, `redirectUri`, `webhookVerify`).
- **`pages/dashboard-tiktok.html`** + **`js/layout-tiktok.js`** — dashboard "em construção" (ver seção própria).
- **`politica-de-privacidade.html`** + **`politica-seguranca.html`** — páginas públicas exigidas pelo questionário de compliance do Partner Center. Ver `.claude/backend.md`.
- Links cruzados no `mkt-switcher-compact` nos 4 layouts (`js/layout.js`, `layout-amazon.js`, `layout-shopee.js`, `layout-tiktok.js`).

## Terminologia e endpoints — confirmados por doc oficial (07/09/2026)

`partner.tiktokshop.com` e domínios relacionados seguem bloqueados pelo proxy de saída deste ambiente — não é possível navegar a doc por conta própria aqui. Nesta rodada, porém, o **usuário exportou várias páginas oficiais em .md e colou diretamente** — isso é 🟢 **DOCUMENTADO PELA TIKTOK** de verdade, não mais inferência de SDK de terceiro (`ecomphp/tiktokshop-php`, usado numa rodada anterior e que continha pelo menos 2 erros: URL de autorização errada e `event_type` de webhook como número em vez de string). Onde a doc diverge do SDK, **a doc sempre vence** — já corrigido no código.

### Autorização — 3 fluxos diferentes por dono do dado

| Tipo | Dono do dado | Entrada US | Entrada ROW (Brasil) |
|---|---|---|---|
| **Seller** (o nosso) | Seller/loja | `services.us.tiktokshop.com/open/authorize` | `services.tiktokshop.com/open/authorize` |
| Creator | Creator | `shop.tiktok.com/alliance` | idem |
| Partner | Partner (TAP) | `partner.us.tiktokshop.com/open/authorize` | `partner.tiktokshop.com/open/authorize` |

`getAuthorizationUrl()` usa a entrada de **Seller ROW**. ⚠️ Os parâmetros exatos dessa URL específica (`app_key`+`state`? outros?) não vieram na doc recebida até agora — os params atuais no código foram herdados do SDK de terceiro (que usa outro host, `auth.tiktok-shops.com/oauth/authorize` — não confirmado que os mesmos params valham pra `services.tiktokshop.com/open/authorize`). **Página que resolveria isso**: "Authorization overview" (`authorization-overview-202407`), citada várias vezes mas ainda não recebida no formato .md completo.

- OAuth usa **App Key/App Secret** e `grant_type=authorized_code` (grafia não-padrão, proposital).
- Troca de código: `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key=&app_secret=&auth_code=&grant_type=authorized_code`. Resposta: `{access_token, refresh_token, access_token_expire_in, user_type}` — **NÃO** traz `shop_id`/`shop_cipher`.
- Descobrir a loja: `GET authorization/{version}/shops` com o access_token recém-emitido, **sem** `shop_cipher` na assinatura (endpoints `/authorization/...` excluem esse parâmetro). `TiktokClient.getAuthorizedShops()`.
- Refresh: `GET .../api/v2/token/refresh?...&grant_type=refresh_token`.
- Escopos têm 2 categorias (doc "Download SDK"): **Public API scope** (autoatendimento, App & Service → Manage → Manage API) e **Private API scope** (precisa aprovação/convite/habilitação por mercado — pode ser o caso de Finance/Order pro Brasil, mercado novo; não confirmado).
- **Não existe mais sandbox como host separado** desde a API 202309 (nota do SDK), mas existe um fluxo oficial equivalente: **"Create a test seller account"** + **"Generate a test access token"** — testar contra uma loja de teste real, não direto em produção.

### Assinatura de request de negócio (Shop API)

`sign = HMAC-SHA256(app_secret, app_secret + path + query_ordenada(sem sign/access_token) + body + app_secret)`, hex minúsculo, parâmetro `sign` na query. `shop_cipher` só entra quando a conta já tem um. Path no formato `{categoria}/{version}/{ação}` (ex.: `order/202309/orders/search`).

### Assinatura de webhook — 🟢 TESTADA CONTRA VETOR OFICIAL, bate 100%

`signature = HMAC-SHA256(app_secret, app_key + raw_body)`, hex minúsculo, header `Authorization`, **sem** prefixo "Bearer", **sem** timestamp (sem proteção a replay). Verificado nesta sessão rodando o exemplo reproduzível oficial (app_key=`abcdef`, app_secret=`123`, body de exemplo) contra a implementação em `tiktokWebhook.js` — resultado idêntico ao esperado pela doc.

### Webhooks — lista completa de tópicos (doc "Webhooks Overview")

`event_type` no cadastro é **STRING** (correção: uma versão anterior desta doc dizia que era numérico, inferido do SDK — errado, revertido). O payload TAMBÉM traz um `type` **numérico**, mas a doc avisa explicitamente: *"Do not branch only on the numeric type; use the subscribed event_type context"* — por isso `tiktokWebhook.js` não filtra mais por `type` numérico, só verifica `data.order_id` (a URL só está cadastrada pro tópico de pedido mesmo).

| `event_type` | Gatilho |
|---|---|
| `ORDER_STATUS_CHANGE` | Pedido criado ou muda de status — **único tratado na Fase 1** |
| `RECIPIENT_ADDRESS_UPDATE` | Endereço do destinatário atualizado |
| `PACKAGE_UPDATE` | Pacote combinado/dividido/alterado |
| `PRODUCT_STATUS_CHANGE` | Resultado de auditoria de produto |
| `SELLER_DEAUTHORIZATION` | Seller revogou o app — parar chamadas e limpar estado local |
| `UPCOMING_AUTHORIZATION_EXPIRATION` | Autorização expira em 30 dias; depois, diariamente às 00:00 até reautorizar |
| `CANCELLATION_STATUS_CHANGE` | Status de cancelamento mudou |
| `RETURN_STATUS_CHANGE` | Status de devolução mudou |
| `NEW_CONVERSATION` / `NEW_MESSAGE` / `NEW_MESSAGE_LISTENER` | Customer service |
| `PRODUCT_INFORMATION_CHANGE` / `PRODUCT_CREATION` / `PRODUCT_CATEGORY_CHANGE` | Catálogo |
| `INVOICE_STATUS_CHANGE` | Status de upload de invoice |
| `PRODUCT_AUDIT_STATUS_CHANGE` | Auditoria de produto |
| `REVERSE_STATUS_UPDATE` | Comprador abriu cancelamento/reembolso/devolução que precisa de ação do seller |

**Recomendação da doc**: assinar `UPCOMING_AUTHORIZATION_EXPIRATION` + `SELLER_DEAUTHORIZATION` pra manter o ciclo de vida da conexão — **não implementado ainda** (Fase 1 só assina `ORDER_STATUS_CHANGE`); candidato natural pra Fase 1.5.

Payload: `{type, tts_notification_id, shop_id, timestamp, data}` — `tts_notification_id` **confirmado que existe** (usar pra idempotência quando presente; o dedupe do BullMQ já usa `storeId+orderId` como `jobId`, que não depende desse campo). Gestão via API: `GET event/{v}/webhooks` (lista), `PUT event/{v}/webhooks` `{address, event_type}` (registra/atualiza), `DELETE event/{v}/webhooks` `{event_type}` (remove).

### Pedidos

- `POST order/{v}/orders/search` — `page_size`/`sort_order`/`page_token`/`sort_field` na query, resto do filtro (`update_time_ge` etc.) no body.
- `GET order/{v}/orders?ids=id1,id2,...` — detalhe (plural, sempre por query, nunca `orders/{id}`).
- `GET order/{v}/orders/{id}/price_detail` — detalhamento de preço/desconto/taxa (não usado ainda; ⚠️ ver known-bugs.md sobre COMPLETED×reembolso).
- **Order/SKU/Order Line Item** (doc "Order API overview"): 1 Order pode ter várias linhas de SKU, cada linha pode ter vários "line items" (unidades individuais) — a granularidade mais fina de um pedido é o line item, não a linha de SKU.
- **Enum de `order_status` — 9 valores confirmados, com máquina de estados completa**:

| Status | Definição |
|---|---|
| `UNPAID` | Pedido feito, pagamento ainda não autorizado |
| `ON_HOLD` | Pago, em período de arrependimento (1h) — **não pode ser fulfillado ainda** |
| `AWAITING_SHIPMENT` | Aguardando o seller postar |
| `PARTIALLY_SHIPPING` | Só em envios divididos — parte já enviada |
| `AWAITING_COLLECTION` | Postado, aguardando coleta da transportadora |
| `IN_TRANSIT` | Coletado, a caminho |
| `DELIVERED` | Entregue |
| `COMPLETED` | Finalizado — **⚠️ pode ser "entregue" OU "reembolsado 100% antes de chegar"**, ver `known-bugs.md` |
| `CANCELLED` | Cancelado — só o mercado americano cancela a partir de `AWAITING_COLLECTION` (não assumir isso pro Brasil) |

`mapTiktokStatus()` (`marketplaceEventWorker.js`) já cobre os 9 (o SDK de terceiro usado antes só tinha 8 — faltava `ON_HOLD`, corrigido).

### Erros

Resposta HTTP 200 com `{code, message, data, request_id}`; `code=0` é sucesso. Token/auth inválido quando os 3 primeiros dígitos do `code` são `105` ou `360`.

### APIs por categoria (12 confirmadas — "TTS API Overview")

Product, Order, Fulfillment, Return & Refund, Logistics, Promotion, Finance, Seller, Authorization, Events, **Data Reconciliation** (nova pra nós — reconciliação de dados externos com o Quality Engine, não relevante), Supply Chain (armazéns certificados TikTok). Ver mapa de importância na seção seguinte.

## O que falta confirmar

1. **Parâmetros exatos da URL de autorização de Seller** (`services.tiktokshop.com/open/authorize`) — só temos o host/path confirmado; os query params foram herdados de outro host (SDK de terceiro). Resolveria com a página "Authorization overview" (`authorization-overview-202407`) completa.
2. **Nomes exatos dos campos na resposta de pedido** (`orders`/`orders/search`) e de `authorization/{v}/shops` — nenhuma fonte recebida até agora mostrou o JSON de resposta real, só a request.
3. **Rate limits reais** — nem SDK nem as páginas recebidas até agora trazem números. A doc oficial confirma que existe uma página específica sobre isso, ainda não recebida.
4. **Disponibilidade real da API pro Brasil** — nenhuma página confirmou/negou isso explicitamente ainda.

## Webhook — implementado, sem gate por type numérico

Receptor isolado: `server/src/routes/tiktokWebhook.js`, `/webhooks/tiktok`, antes do `express.json()` global (`express.raw()`). Fluxo: 200 imediato → valida assinatura → (sem filtrar por `type` numérico, ver seção acima) → checa `data.order_id` → enfileira o mesmo evento do polling (`jobId` `TIKTOK:ORDER_UPDATED:{storeId}-{orderId}`) → `handleTiktokOrderEvent` processa em tempo real.

- **Configuração**: `PUT event/{v}/webhooks` `{address: 'https://multimixvendas.duckdns.org/webhooks/tiktok', event_type: 'ORDER_STATUS_CHANGE'}` (string, não número).
- **Escape hatch**: `TIKTOK_WEBHOOK_VERIFY=false`.
- **Dedup com o polling**: mesmo `jobId` → BullMQ ignora duplicata.

## Dashboard dedicado (`pages/dashboard-tiktok.html`)

Estado atual: **"em construção"** (classe `.em-construcao`). Todo o HTML/JS real fica comentado no arquivo, pronto pra reativar quando `/auth/tiktok/login` autorizar a 1ª conta.

## Páginas públicas de política

`politica-de-privacidade.html`/`politica-seguranca.html`/`protecao_dados_pessoais.html` (rotas dedicadas em `server.js`, whitelisted em `staffAuth.js`) — exigidas pelo questionário de segurança/privacidade do Partner Center (link + evidência por pergunta; evidência de infraestrutura real só o usuário pode capturar). Campos `[PREENCHER: ...]` (razão social/CNPJ, e-mail, infraestrutura de rede) ainda pendentes de preenchimento nas 2 primeiras.

`protecao_dados_pessoais.html` (`/protecao_dados_pessoais`) responde à pergunta "sua organização tem uma política interna [de proteção de dados pessoais]?" — é a **versão web em português, traduzida fielmente**, do PDF que o usuário já submeteu ao TikTok (`Personal Information Protection Standard — FinanceEcom`, v1.0, emitido 07/09/2026: 14 seções + tabela de controle de documento). Usa o nome **"FinanceEcom"** (nome do sistema/projeto no PDF já enviado), não "Multimix Vendas" — mantém consistência com o que já foi submetido ao TikTok. Sem campos `[PREENCHER: ...]` — o PDF original já usa "FinanceEcom Management" como responsável, sem CNPJ, então a tradução seguiu o mesmo nível de detalhe do documento oficial já entregue.

## O que NÃO foi feito nesta fase

Ao contrário da Shopee: sem catálogo, chat, promoções/cupons, financeiro/repasse, devoluções, papel de login tipo `shopee-demo`. Seguir o mesmo padrão incremental da Shopee se o usuário pedir depois.

## O que NÃO fazer

- Não adicionar cliente TikTok direto no frontend — só via `/api/tiktok/*`.
- Não inventar nomes de campo/endpoint além do confirmado acima — usar "O que falta confirmar" como checklist.
- Nunca colar `App Secret`/tokens em chat — só em `server/.env`.
- Não presumir que um SDK de terceiro está certo quando diverge da doc oficial — doc sempre vence (2 erros reais já encontrados assim: URL de autorização, tipo do `event_type`).
