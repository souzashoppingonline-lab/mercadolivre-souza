# Integração — Amazon

> Status atual: **ligada ao banco/worker desde v15, rodando em sandbox.** App já criado (`FinanceEcom`), com **Status = Sandbox** no Developer Console (Solution Provider Portal) — ainda sem "Autorizações restantes" de produção aprovadas pela Amazon, então as chamadas retornam dados de teste estáticos, não pedidos reais. Todas as credenciais já configuradas em `server/.env`. Ver `.claude/decisions.md` (Marketplace Engine) e `.claude/workers.md` (seção "Eventos de outros marketplaces").

## O que já existe

- `server/src/marketplaces/interfaces/MarketplaceClient.js` — contrato comum de todo adapter de marketplace (`refreshAccessToken`, `getOrder`, `listRecentOrders`).
- `server/src/marketplaces/base/errors.js` — `MarketplaceRateLimitError`, `MarketplaceTokenInvalidError`, `MarketplaceTransientError`, compartilhadas entre adapters.
- `server/src/marketplaces/amazon/amazonClient.js` — troca `AMAZON_REFRESH_TOKEN` por access token via LWA, chama a SP-API (`getOrder`, `listRecentOrders`). Suporta sandbox e produção via `AMAZON_ENV`.
- `server/src/marketplaces/interfaces/EventSource.js` — contrato `start/stop/discoverEvents` para descoberta de eventos de marketplace, independente do mecanismo (polling, webhook, Notifications API).
- `server/src/marketplaces/Scheduler.js` — orquestra múltiplas `EventSource`, chamando `discoverEvents()` no intervalo registrado.
- `server/src/marketplaces/amazon/AmazonPollingEventSource.js` — implementação real do `EventSource` para a Amazon, **uma instância por conta** (por linha de `stores`): a cada 15 min, lê o cursor em `marketplace_sync_state` (chave `source_key = stores.id`), chama `AmazonClient.listRecentOrders`, e publica um evento padronizado por pedido (`{marketplace:'AMAZON', event:'ORDER_UPDATED', resourceId, storeId, sellerId, timestamp}`) na fila BullMQ `marketplace-events-amazon`. `storeId` é a chave de roteamento — identifica de qual conta veio o pedido.
- `server/src/queues/marketplaceEventQueue.js` — fila BullMQ por marketplace (mesmo padrão de `queues/webhookQueue.js` do ML) — compartilhada entre todas as contas Amazon, não uma fila por conta.
- `server/src/marketplaceEventWorker.js` — no boot, busca todas as linhas de `stores` com `marketplace_id=AMAZON` e registra uma `AmazonPollingEventSource` + um `AmazonClient` por conta (mapa `clients` chaveado por `stores.id`). Ao consumir um evento, usa `evt.storeId` para achar o client certo e gravar `orders.store_id` — nada fixo/hardcoded. **Totalmente desacoplado** do dispatch table `handlers`/`processJob` do ML — `worker.js` só ganhou 2 linhas aditivas no final do arquivo para iniciar esse worker novo.
- `config/env.js` tem o namespace `amazon` (`appId`, `lwaClientId`, `lwaClientSecret`, `refreshToken`, `marketplaceId`, `region`, `env`), lido de `server/.env` — esses valores são os **defaults globais**; `lwaClientId`/`lwaClientSecret`/`env` (sandbox/production/mock) são compartilhados por todas as contas (identificam o app, não o seller), enquanto `refreshToken`/`marketplaceId`/`region` são sobrepostos por conta quando a linha de `stores` correspondente tiver valor (ver Schema abaixo).

## Suporte a múltiplas contas (v16)

Cada conta Amazon é uma linha em `stores` com `marketplace_id=AMAZON`:
- `stores.refresh_token` — refresh token OAuth **dessa conta** (mesma coluna genérica que o ML usa).
- `stores.amazon_marketplace_id` / `stores.amazon_region` — override por conta (uma conta pode vender no Brasil, outra nos EUA); quando `NULL`, cai para `AMAZON_MARKETPLACE_ID`/`AMAZON_REGION` do `.env` (mesmo padrão de `ml_client_id`/`ml_client_secret` já usado pelo ML, ver `auth.js`).
- `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET` continuam **só globais** — identificam o app na Amazon (Login with Amazon), não o seller; todas as contas autorizadas ao mesmo app `FinanceEcom` compartilham esse client.

**Como adicionar uma segunda conta hoje**: ainda não existe rota/UI para isso — é um `INSERT INTO stores (id, nickname, marketplace_id, refresh_token, amazon_marketplace_id, amazon_region) VALUES (...)` manual (id sintético seguindo a convenção `9000000002`, `9000000003`...), reiniciar o `ml-worker-novo.service`, e a nova conta é automaticamente registrada no `Scheduler` no próximo boot. Uma rota REST dedicada para cadastrar contas fica como próximo passo em `todo.md`.

## Schema (v15/v16 — ver `database.md` para colunas completas)

- Tabela `marketplaces` (catálogo: `ML`, `AMAZON`, `SHOPEE`, `MAGALU`, `TIKTOK`) + coluna `marketplace_id` em `stores`/`orders`/`items`/`messages` (v15).
- `orders.ml_id` deixou de ser `BIGINT` e virou `TEXT` (IDs de pedido Amazon não são numéricos) — mesmo nome de coluna por ora, guardando IDs de qualquer marketplace (v15).
- `amazon_order_data` — campos exclusivos da Amazon (`amazon_order_id`, `seller_id`, `fulfillment_channel`, `order_type`, `raw_data`), `orders` continua só com os campos comuns entre marketplaces (v15).
- `marketplace_sync_state` — cursor de última sincronização por conta (`source_key = stores.id`), usado pelo `AmazonPollingEventSource` (v15).
- `stores.amazon_marketplace_id` / `stores.amazon_region` — override de credencial por conta (v16, ver acima).
- Store sentinela `id=9000000001` (`nickname='Amazon'`) — a primeira conta cadastrada; contas adicionais seguem a mesma convenção de id sintético.

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

## Sandbox estático — valores literais obrigatórios

O sandbox **estático** da SP-API não aceita parâmetros reais (data/marketplace/orderId) — ele faz *pattern-matching* e só reconhece os valores exatos documentados pela Amazon (confirmado no modelo oficial `ordersV0.json`, seção `x-amzn-api-sandbox.static`):
- `GET /orders/v0/orders`: `CreatedAfter=TEST_CASE_200` + `MarketplaceIds=ATVPDKIKX0DER` → devolve uma lista fixa de pedidos de teste.
- `GET /orders/v0/orders/{orderId}`: o path precisa ser literalmente `TEST_CASE_200` (não o `AmazonOrderId` real devolvido pela lista) → devolve o pedido de teste `AmazonOrderId=902-1845936-5435065`.

Qualquer outro valor retorna `400 InvalidInput "Could not match input arguments"` — foi exatamente o que aconteceu em produção: `listRecentOrders` já usava os literais certos e funcionou, mas `getOrder` chamado com o `AmazonOrderId` real (devolvido pela lista) falhava, porque o sandbox exige o literal `TEST_CASE_200` também no path. `amazonClient.js` (`listRecentOrders` e `getOrder`) já trata os dois casos: quando `AMAZON_ENV !== 'production'`, ignora os valores reais e usa os literais de teste — a resposta é sempre o mesmo pedido fixo, não dados reais. Em produção os valores reais são usados normalmente.

**Limite de investigação de sandbox respeitado**: essas duas correções vieram direto do modelo oficial da SP-API (não tentativa e erro). Qualquer outro comportamento inconsistente do sandbox estático (fora esses dois padrões documentados) não deve ser mais investigado — o resto do desenvolvimento usa o `MockEventSource` abaixo, e a validação de verdade só acontece quando o app tiver acesso de produção aprovado.

## Modo mock — `AMAZON_ENV=mock`

`server/src/marketplaces/mock/mockProvider.js` implementa `MockClient` (contrato `MarketplaceClient`) e `MockEventSource` (contrato `EventSource`), gerando pedidos fabricados variados (status, valores, `AmazonOrderId` diferentes a cada execução — ~70% de chance de "descobrir" 1 pedido novo a cada 2 min) e publicando na **mesma fila** `marketplace-events-amazon` que a Amazon real usaria. `marketplaceEventWorker.js` decide entre `AmazonClient`/`AmazonPollingEventSource` (real) e `MockClient`/`MockEventSource` (fabricado) só olhando `AMAZON_ENV` — nenhum outro arquivo do pipeline (fila, `handleOrderEvent`, `orders`/`amazon_order_data`, dashboard) precisa saber qual dos dois está ativo. Serve para testar dashboard/KPIs/financeiro com dados variados sem depender do sandbox estático da Amazon (que sempre devolve o mesmo pedido fixo). Trocar para a Amazon real de verdade é só mudar `AMAZON_ENV` para `sandbox` ou `production`.

**Opt-in explícito obrigatório (proteção contra venda fake em produção)**: `AMAZON_ENV=mock` **sozinho não gera mais pedido de teste** — precisa também de `AMAZON_MOCK_ENABLED=true` no `.env`. Isso surgiu porque o `.env` de produção ficou em `AMAZON_ENV=mock` e o dashboard passou a receber "vendas da Amazon" fantasmas (`MOCK-...`), que o usuário mandou remover. Comportamento hoje: se `AMAZON_ENV=mock` sem `AMAZON_MOCK_ENABLED=true`, a Amazon é **totalmente desativada** no `marketplaceEventWorker` (não gera mock e não cai no polling real com credenciais de sandbox) e loga um aviso. Para limpar pedidos de teste já gravados: `DELETE FROM amazon_order_data WHERE amazon_order_id LIKE 'MOCK-%'; DELETE FROM orders WHERE ml_id LIKE 'MOCK-%';`.

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
