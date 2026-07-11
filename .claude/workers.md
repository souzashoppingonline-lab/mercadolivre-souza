# Workers (BullMQ)

> Escopo: o processo `server/src/worker.js` — filas, concorrência, retries, jobs agendados e o bot do Telegram. Para o que cada handler grava no banco, ver `database.md`. Para como falamos com a API do ML dentro dos handlers, ver `mercadolivre.md`. **Sempre que um handler de tópico ou um sync agendado for criado/alterado, atualize este arquivo na mesma tarefa.**

## Filas — uma por loja

`queues/webhookQueue.js` cria (`getQueue(storeId)`) uma `Queue` BullMQ por loja, nomeada `ml-webhooks-{storeId}`, com `attempts: 3` e `backoff: exponential 60000ms` como default (o Gateway sobrescreve para `attempts: 5, backoff: exponential 10000ms` — ver `mercadolivre.md`/`api.md` sobre `webhookGateway.js`).

`worker.js` sobe um `Worker` BullMQ por loja existente no banco (`SELECT id FROM stores`) mais uma fila `'default'` (jobs sem `storeId` conhecido) e uma fila legada `ml-webhooks` (compatibilidade com jobs antigos sem particionamento por loja).

```js
concurrency: 3
limiter: { max: 3, duration: 3000 }   // ≈60 req/min por loja
```

Isolar por loja garante que o rate limit da API do ML de uma loja não trava o processamento das demais (cada loja tem app ML próprio, logo rate limit independente).

## `jobId` estável — deduplicação

O Gateway (`webhookGateway.js`) usa `jobId = \`${topic}:${resource}:${storeId}\`` ao enfileirar. Isso impede que BullMQ crie um job duplicado enquanto outro para o **mesmo recurso** ainda está esperando/ativo/em retry (ex.: ML reenvia o mesmo webhook antes do primeiro terminar). O job é removido da fila ao completar/descartar, então um novo webhook para o mesmo recurso depois disso é processado normalmente.

## Handlers por tópico (`handlers` map em `worker.js`)

| Tópico ML | Handler | Ação |
|---|---|---|
| `orders_v2` | `handleOrder` | busca `/orders/:id`, upsert em `orders`, invalida `kpis:*`, publica `order_updated`, notifica Telegram (`tg_vendas`) só na transição real para `status='paid'` **e** se `date_closed`/`date_created` do pedido tiver menos de 24h (evita notificar como "Nova venda!" um pedido antigo que só agora entrou no banco via webhook tardio de `shipments`/`payments`) — mensagem inclui data/hora da venda e do disparo do alerta |
| `payments` | `handlePayment` | busca `/collections/:id`, extrai `order_id`, delega para `handleOrder` |
| `questions` | `handleQuestion` | busca `/questions/:id`, upsert em `questions`, publica `question_received`, notifica Telegram (`tg_perguntas`) se `UNANSWERED`, salva `tg_message_id` para permitir responder via reply (ver `known-bugs.md`) |
| `messages` | `handleMessage` | busca `/messages/:id`, upsert em `messages` (incrementa `unread`), publica `message_received`, notifica Telegram (`tg_mensagens`) |
| `items` | `handleItem` | busca `/items/:id`, upsert em `items`, detecta mudanças (`title`/`price`/`stock`/`status`) e grava em `item_changes`, publica `stock_alert` se `available_quantity <= 5`, publica `anuncio_updated`, notifica Telegram (`tg_reposicao` e/ou `tg_anuncios`) |
| `public_offers` | `handleOffer` | resolve `item_id` a partir do `offer_id` (regex, sem chamar API), tenta `mlClient.getOffer` com fallback para preços locais (`items`/`price_history`) se der erro, upsert em `promotions`, publica `promo_changed`, notifica Telegram (`tg_promocoes`) |
| `post_purchase` | `handlePostPurchase` | busca `/post-purchase/claims/:id`, upsert em `returns`, publica `devolucao_recebida`, notifica Telegram (`tg_devolucoes`) se `status='opened'` |
| `items_prices` | `handleItemPrice` | registra em `price_history` o preço anterior conhecido (não chama API — o novo preço chega depois via tópico `items`) |
| `shipments` | `handleShipment` | localiza o pedido pelo `shipment_id` em `raw_data`; se não achou ou já atualizou há <30min, só toca `updated_at`; senão reprocessa via `handleOrder` |
| `invoices`, `public_candidates`, `stock-locations` | `noop` | recebidos mas ignorados (sem handler de negócio) |

Cada handler que grava dados relevantes para cache também é responsável por invalidar a chave Redis correspondente (ver `redis.md`).

## `processJob` — pipeline de execução de cada job

1. Valida se o token da loja é válido (`stores.token_expires_at`); se expirado, descarta o job (`expiredStores` Set evita log repetido).
2. Verifica cooldown ativo (`apiCooldown` Map, chave `topic:storeId`) — se em cooldown, marca `webhook_logs.status='skipped'` e não processa.
3. Executa o handler; em sucesso marca `status='processed'`.
4. Em erro:
   - `TOKEN_INVALID` / `err.permanent` → notifica Telegram (`tg_token`), não retenta.
   - `OAUTH_RATE_LIMITED` → notifica (throttle de 1h por loja via `oauthNotified`), não retenta.
   - `429` genérico com `attemptsMade < 4` → relança (BullMQ aplica o backoff exponencial de 10s do Gateway).
   - `429` esgotando as 5 tentativas → aplica cooldown de 5 min naquele `topic:storeId` (`apiCooldown`) e conta em `track429` (alerta Telegram `tg_429` se ≥3 cooldowns em 10 min).
   - Outros erros → relança (BullMQ registra `failed`; 5 falhas consecutivas seguidas disparam alerta `tg_fila`).

## Jobs agendados (cron manual via `setTimeout` recursivo — `scheduleAt`)

Não usa `node-cron`; cada job se reagenda no `finally` chamando `scheduleAt(hora, minuto, fn, label)` de novo.

| Horário (BRT) | Job | O que faz |
|---|---|---|
| 01:00 | `syncScores` | busca `/item/:id/performance` para até 100 itens ativos por loja, grava em `item_performance`. 10s entre itens, pausa 30s a cada 10, aborta a loja após 5 429 seguidos |
| 01:30 | `syncParentItems` | preenche `items.parent_item_id` via multiget (lotes de 20, 30s entre lotes/lojas) |
| 02:00 | `syncVisitas` | coleta visitas do dia anterior por item ativo (até 300/loja), 20s entre itens |
| 03:00 | `syncVendas` (alias `dailySync`) | reconcilia pedidos das últimas 72h via `/orders/search`, paginado, chama `handleOrder(..., silent: true)` para não gerar notificação "Nova venda!" duplicada |
| 04:15 | `syncMetricas` | reputação (`store_metrics`) + devoluções recentes (`returns`) |
| 05:00 | `syncPrecos` | atualiza `items.original_price` de itens não fechados; zera se não há promoção ativa |
| 06:00 | `resumoDiario` | envia ao Telegram (`tg_resumo`, sempre — não respeita as flags de tópico) o resumo do dia anterior por loja e por modal de logística |

Todos (exceto `resumoDiario` e `tokenRefreshLoop`) são registrados em `schedule_jobs`/`schedule_runs` via `recordSync(name, cron, fn)` — consultável em `GET /api/schedule/jobs` e `GET /api/schedule/runs`.

Outros loops independentes:
- `tokenRefreshLoop` — roda no boot e a cada 30 min; renova token se faltar <4h, alerta Telegram (`tg_token`) escalonado (a cada 6h se >48h, sempre se <4h). Tokens "epoch zero" (`token_expires_at < ano 2000`, ver `mercadolivre.md`) nunca são renovados automaticamente — só alerta, exige reconexão manual.
- `reprocessSkipped` — roda no boot (+5min) e a cada 30 min; reprocessa `webhook_logs` com `status='skipped'` e `topic='orders_v2'` das últimas 4h, respeitando o cooldown ainda ativo.
- Sync inicial automático de vendas 2 min após o boot, **só fora do horário de pico** (22h–08h) para não competir com tráfego de webhook.

## Eventos de outros marketplaces — v15 (`marketplaceEventWorker.js`, processo à parte do dispatch acima)

Desde v15, `worker.js` também sobe (2 linhas aditivas no final do arquivo, nenhum handler ML tocado) um segundo `Worker` BullMQ, definido em `server/src/marketplaceEventWorker.js`, que consome eventos padronizados de EventSources de marketplace — hoje só a Amazon. Este worker **não conhece** o dispatch table `handlers`/`processJob` do ML e vice-versa; são pipelines paralelos e independentes.

- **Descoberta de eventos**: `server/src/marketplaces/Scheduler.js` orquestra `EventSource`s registradas (`server/src/marketplaces/interfaces/EventSource.js`: `start/stop/discoverEvents`). Hoje só `AmazonPollingEventSource` (`marketplaces/amazon/AmazonPollingEventSource.js`) está registrada, com polling a cada 15 min — a Amazon SP-API não tem webhook simples "topic+resource" como o ML.
- Cada execução de `discoverEvents()` lê o cursor `last_synced_at` de `marketplace_sync_state` (24h atrás na 1ª execução), chama `AmazonClient.listRecentOrders`, e publica um evento por pedido na fila `marketplace-events-amazon` (`queues/marketplaceEventQueue.js`), com `jobId` estável `AMAZON:ORDER_UPDATED:{amazonOrderId}` (mesma técnica anti-duplicata do Gateway ML).
- **Consumo**: o `Worker('marketplace-events-amazon', ...)` em `marketplaceEventWorker.js` busca o pedido completo (`AmazonClient.getOrder`), faz upsert em `orders` (com `marketplace_id`, `store_id` = store sentinela `9000000001`) e nos campos exclusivos em `amazon_order_data`, invalida `kpis:summary` e publica `order_updated` no WS — mesmo formato que o pipeline ML usa, para as telas do dashboard não precisarem saber a origem.
- Notificação Telegram de vendas Amazon **não está implementada** (fora de escopo da v15 — ver `todo.md`).
- Se `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET` não estiverem configurados, `discoverEvents()` é um no-op silencioso (mesma postura defensiva do `amazonClient.js`).

## Comandos manuais (canal Redis `worker:cmd`)

Aceita `{ cmd }` ∈ `dailySync`/`syncVendas`, `syncMetricas`, `syncReturns` (busca retroativa completa, não agendada), `syncParentItems`, `syncVisitas`, `syncPrecos`, `syncScores`, `reprocessSkipped`. Disparado por `POST /api/schedule/jobs/:name/trigger` ou `server/sync-now.sh`.

## Bot do Telegram (long polling)

`tgBotLoop` faz long polling em `getUpdates` (timeout 25s, se reagenda a cada 1s de intervalo entre chamadas). Não usa webhook do Telegram para comandos — só para replies de perguntas (`POST /webhooks/telegram`, ver `api.md`). Comandos suportados (`handleTgCommand`):

| Comando | Ação |
|---|---|
| `/status` | status de token de todas as lojas |
| `/refresh [nome]` | força refresh de token (todas as expiradas, ou busca parcial por nome) |
| `/sync vendas\|metricas\|visitas\|devolucoes` | dispara o sync correspondente |
| `/help`, `/start` | lista de comandos |

Notificações Telegram em geral (`tgNotify`) respeitam: flag por tópico em `app_config` (`tg_*` = `'false'` desativa), janela de silêncio (`silence_start`/`silence_end`, padrão 22:00–07:00) e intervalo mínimo entre envios do mesmo tópico (`tg_interval`, minutos). `tgNotifyForce` (usado por `syncVendas`, `syncMetricas`, `resumoDiario`) ignora essas regras — sempre envia.
