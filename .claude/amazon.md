# Integração — Amazon

> Status atual: **ligada ao banco/worker desde v15, rodando em sandbox.** App já criado (`FinanceEcom`), com **Status = Sandbox** no Developer Console (Solution Provider Portal) — ainda sem "Autorizações restantes" de produção aprovadas pela Amazon, então as chamadas retornam dados de teste estáticos, não pedidos reais. Todas as credenciais já configuradas em `server/.env`. Ver `.claude/decisions.md` (Marketplace Engine) e `.claude/workers.md` (seção "Eventos de outros marketplaces").

## O que já existe

- `server/src/marketplaces/interfaces/MarketplaceClient.js` — contrato comum de todo adapter de marketplace (`refreshAccessToken`, `getOrder`, `listRecentOrders`).
- `server/src/marketplaces/base/errors.js` — `MarketplaceRateLimitError`, `MarketplaceTokenInvalidError`, `MarketplaceTransientError`, compartilhadas entre adapters.
- `server/src/marketplaces/amazon/amazonClient.js` — troca `AMAZON_REFRESH_TOKEN` por access token via LWA, chama a SP-API (`getOrder`, `listRecentOrders`). Suporta sandbox e produção via `AMAZON_ENV`.
- `server/src/marketplaces/interfaces/EventSource.js` — contrato `start/stop/discoverEvents` para descoberta de eventos de marketplace, independente do mecanismo (polling, webhook, Notifications API).
- `server/src/marketplaces/Scheduler.js` — orquestra múltiplas `EventSource`, chamando `discoverEvents()` no intervalo registrado.
- `server/src/marketplaces/amazon/AmazonPollingEventSource.js` — implementação real do `EventSource` para a Amazon: a cada 15 min, lê o cursor em `marketplace_sync_state`, chama `AmazonClient.listRecentOrders`, e publica um evento padronizado por pedido (`{marketplace:'AMAZON', event:'ORDER_UPDATED', resourceId, sellerId, timestamp}`) na fila BullMQ `marketplace-events-amazon`.
- `server/src/queues/marketplaceEventQueue.js` — fila BullMQ por marketplace (mesmo padrão de `queues/webhookQueue.js` do ML).
- `server/src/marketplaceEventWorker.js` — consome a fila acima, busca o pedido completo, faz upsert em `orders` (campos comuns, `marketplace_id`, `store_id` = store sentinela `9000000001`) e nos campos exclusivos em `amazon_order_data`. **Totalmente desacoplado** do dispatch table `handlers`/`processJob` do ML — `worker.js` só ganhou 2 linhas aditivas no final do arquivo para iniciar esse worker novo.
- `config/env.js` tem o namespace `amazon` (`appId`, `lwaClientId`, `lwaClientSecret`, `refreshToken`, `marketplaceId`, `region`, `env`), lido de `server/.env`.

## Schema (v15 — ver `database.md` para colunas completas)

- Tabela `marketplaces` (catálogo: `ML`, `AMAZON`, `SHOPEE`, `MAGALU`, `TIKTOK`) + coluna `marketplace_id` em `stores`/`orders`/`items`/`messages`.
- `orders.ml_id` deixou de ser `BIGINT` e virou `TEXT` (IDs de pedido Amazon não são numéricos) — mesmo nome de coluna por ora, guardando IDs de qualquer marketplace.
- `amazon_order_data` — campos exclusivos da Amazon (`amazon_order_id`, `seller_id`, `fulfillment_channel`, `order_type`, `raw_data`), `orders` continua só com os campos comuns entre marketplaces.
- `marketplace_sync_state` — cursor de última sincronização usado pelo `AmazonPollingEventSource`.
- Store sentinela `id=9000000001` (`nickname='Amazon'`) — só uma conta Amazon configurada hoje via `.env`, sem descoberta dinâmica de lojas como o ML tem.

## Credenciais

| Credencial | Status |
|---|---|
| Nome do app (`FinanceEcom`) | ✅ |
| `AMAZON_APP_ID` | ✅ — Application ID do Developer Console, **não** é o mesmo valor que `AMAZON_LWA_CLIENT_ID` |
| `AMAZON_REFRESH_TOKEN` (prefixo `Atzr\|`) | ✅ — token de **sandbox**, não produção |
| `AMAZON_LWA_CLIENT_ID` / `AMAZON_LWA_CLIENT_SECRET` | ✅ |
| `AMAZON_MARKETPLACE_ID` (Brasil = `A2Q3Y263D00KWC`) | ✅ |
| `AMAZON_REGION` | `na` ✅ |
| `AMAZON_ENV` | `sandbox` — trocar para `production` só depois de autorização de produção aprovada pela Amazon no Seller Central |

## O que NÃO foi feito nesta fase (deliberado — ver `decisions.md`/`todo.md`)

- **Normalização completa do schema** (`order_items`/`products`/`inventory`/`shipments`/`customers` como tabelas separadas) — `orders`/`items` continuam "achatados" como sempre foram para o ML; a Amazon usa a mesma estrutura + `amazon_order_data` para o que não é comum. Normalização de verdade fica para uma fase 2 via Strangler Pattern.
- **Nenhuma linha do pipeline ML foi tocada** — `worker.js` (handlers, `processJob`), `webhookGateway.js`, `mlClient.js` seguem exatamente como estavam.
- `MercadoLivreEventSource`/`ShopeeEventSource` reais — não criadas (sem código-esqueleto sem uso); só o padrão `EventSource` está documentado para quando fizer sentido migrá-las.
- Notificação Telegram de vendas Amazon.
- Rota REST dedicada — como o schema usa coluna discriminadora, os endpoints existentes (`api.md`) podem passar a incluir Amazon filtrando/agrupando por `marketplace_id`, mas isso ainda não foi feito nas queries de `routes/api.js`.
- `AMAZON_ENV=production` — depende de aprovação da Amazon, fora de controle do time.

## Particularidades da Amazon a considerar

- **Autenticação**: LWA para o access token — implementado em `amazonClient.js`. AWS Signature v4 (IAM) só é exigida hoje pela Amazon para *restricted operations* (dados pessoais de comprador); a Orders API sem PII funciona só com o bearer token da LWA. Se no futuro precisarmos de PII do comprador, SigV4 vira um item novo aqui.
- **Notificações**: a Amazon usa *Notifications API* (SNS/SQS) em vez de webhook HTTP simples como o ML — por isso o corte atual usa **polling periódico** via `AmazonPollingEventSource`. Assinar a Notifications API (trocando só essa peça, sem tocar no `EventSource`/worker consumidor) fica como evolução futura se o polling não escalar.
- **Rate limits**: a SP-API usa *token bucket* por operação (não por app como o ML). `amazonClient.js` só trata 429 lançando `MarketplaceRateLimitError`; um limiter por operação ainda não existe — a considerar se o polling a cada 15 min começar a esbarrar em rate limit real.
- **Mapeamento de status**: `mapAmazonStatus()` em `marketplaceEventWorker.js` traduz `OrderStatus` da Amazon (`Pending`/`Unshipped`/`Shipped`/`Canceled`) para o vocabulário compartilhado de `orders.status` (`paid`/`pending`/`cancelled`). Ajuste fino de quais valores realmente contam como "pago" só pode ser validado quando pedidos reais (sandbox ou produção) começarem a chegar — hoje sandbox só devolve dados de teste estáticos.

## O que NÃO fazer

Não adicionar chamadas à SP-API no frontend nem em rotas de leitura de `routes/api.js` — mesma regra de fronteira que vale para o Mercado Livre (`architecture.md`, regra 1–3). Não modificar `mlClient.js`/`routes/auth.js`/os handlers de `worker.js` para "generalizar" para Amazon — o ML fica intocado (ver `decisions.md`).
