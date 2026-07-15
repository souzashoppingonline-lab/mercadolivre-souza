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
| `orders_v2` | `handleOrder` | busca `/orders/:id`, upsert em `orders`, invalida `kpis:*`, publica `order_updated`, notifica Telegram (`tg_vendas`) só na transição real para `status='paid'` **e** se `date_closed`/`date_created` do pedido tiver menos de 24h (evita notificar como "Nova venda!" um pedido antigo que só agora entrou no banco via webhook tardio de `shipments`/`payments`) — mensagem inclui data/hora da venda e do disparo do alerta | Resolve e persiste `shipping_type` (logística) em `orders` antes do upsert — a resposta de `/orders/:id` quase nunca traz `shipping.logistic_type`, então busca `/shipments/:id` como fallback, mas só quando ainda não sabe a logística daquele pedido (nem no payload atual, nem já persistida antes), pra não gerar 1 chamada extra à API por webhook já resolvido (ver `decisions.md`).
| `payments` | `handlePayment` | busca `/collections/:id`, extrai `order_id`, delega para `handleOrder` |
| `questions` | `handleQuestion` | busca `/questions/:id`, upsert em `questions`, publica `question_received`, notifica Telegram (`tg_perguntas`) se `UNANSWERED`, salva `tg_message_id` para permitir responder via reply (ver `known-bugs.md`) |
| `messages` | `handleMessage` | busca `/messages/:id`, upsert em `messages` (incrementa `unread`), publica `message_received`, notifica Telegram (`tg_mensagens`) |
| `items` | `handleItem` | busca `/items/:id`, upsert em `items`, detecta mudanças (`title`/`price`/`stock`/`status`) e grava em `item_changes`, publica `stock_alert` se `available_quantity <= 5`, publica `anuncio_updated`, notifica Telegram (`tg_reposicao` e/ou `tg_anuncios`); chama `taskEngine.checkStock(...)` (mesmo limiar `<=5`) — ver `task-engine.md` |
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

## Consultas compartilhadas — `server/src/reports.js`

`getResumoDiarioData()`, `getTopVendas({hours, limit})` e `getResumoSemanal()` vivem em `server/src/reports.js` (não em `worker.js`) — módulo puro de leitura do Postgres, sem BullMQ/Telegram/e-mail. `worker.js` importa essas funções para montar as mensagens/e-mails; `routes/api.js` importa as mesmas funções para as rotas `GET /api/dashboard/resumo-ontem`/`top-vendas-dia`/`resumo-semanal` (consumidas por `pages/top-vendas-online.html`). Única fonte de verdade por cálculo — nunca duplicar a query em worker.js e api.js separadamente (ver `decisions.md`).

`syncTopVendas` (4h/5), a seção "Top vendas do dia" de `emailDailyReports` (24h/10) e `emailRelatorioSemanal` foram refatorados para chamar `getTopVendas`/`getResumoSemanal` em vez de SQL inline — comportamento e mensagens enviadas não mudaram, só a fonte da query. `checkOutlierEstatistico` também foi refatorado para chamar `getOutliersOntem()` — o mesmo array alimenta o alerta Telegram (`tg_outlier`) e o card "Alerta do Dia" de `pages/top-vendas-online.html` (via `GET /api/dashboard/alertas-dia`, que também cruza `getTopVendas` com estoque via `getEstoqueCriticoTopVendas()`).

## Jobs agendados (cron manual via `setTimeout` recursivo — `scheduleAt`)

Não usa `node-cron`; cada job se reagenda no `finally` chamando `scheduleAt(hora, minuto, fn, label)` de novo.

| Horário (BRT) | Job | O que faz |
|---|---|---|
| 01:00 | `syncScores` | busca `/item/:id/performance` para até 100 itens ativos por loja, grava em `item_performance`. 10s entre itens, pausa 30s a cada 10, aborta a loja após 5 429 seguidos |
| 01:30 | `syncParentItems` | preenche `items.parent_item_id` via multiget (lotes de 20, 30s entre lotes/lojas) |
| 02:00 | `syncVisitas` | coleta visitas do dia anterior por item ativo (até 300/loja), **lojas sequenciais** (não paralelo — ver `decisions.md`), 20s entre itens, circuit breaker de 5 429 consecutivos aborta a loja |
| 03:00 | `syncVendas` (alias `dailySync`) | reconcilia pedidos das últimas 72h via `/orders/search`, paginado, chama `handleOrder(..., silent: true)` para não gerar notificação "Nova venda!" duplicada. **Lojas sequenciais**, 20s entre pedidos processados, backoff 60s→120s e circuit breaker de 5 429 consecutivos por loja (mesmo padrão de `syncVisitas`/`syncScores` — ver `decisions.md`) |
| 03:30 | `cleanupPackingVideos` | apaga arquivo (`fs/promises.unlink`) + linha de `packing_videos` com `created_at` mais velho que 30 dias — retenção do módulo Embalagem (ver `embalagem.md`). Não chama a API do ML |
| 04:15 | `syncMetricas` | reputação (`store_metrics`) + devoluções recentes (`returns`) |
| 05:00 | `syncPrecos` | atualiza `items.original_price` de itens não fechados; zera se não há promoção ativa |
| 06:00 | `resumoDiario` | envia ao Telegram (`tg_resumo`, sempre — não respeita as flags de tópico) o resumo do dia anterior por loja e por modal de logística |
| 06:10 | `emailDailyReports` | envia por e-mail (Resend) o "Resumo do Dia" (mesma query de `resumoDiario`, extraída em `getResumoDiarioData()`) e o "Top Vendas do Dia" (top 10, janela de 24h — diferente do alerta de `syncTopVendas`, que é 4h). Cada um só é enviado se o toggle correspondente (`email_resumo`/`email_topvendas`) estiver ligado. Ver `business-rules.md` |
| 06:20 | `checkOutlierEstatistico` | compara a receita de ontem de cada loja ML com a média/desvio histórico do mesmo dia-do-mês (12 meses, recalculado em JS — mesma janela da página BI `analise-vendas-mes.html`); fora de `±1.5` desvio-padrão e com `≥3` meses de histórico, alerta Telegram (`tg_outlier`). Ver `business-rules.md` |
| 2ª 07:00 | `emailRelatorioSemanal` | e-mail com vendas dos últimos 7 dias vs. 7 dias anteriores (pedidos/receita/margem — mesma fórmula de `GET /api/vendas/detalhado`, ver `finance.md`), por loja, e curva ABC top 10 (mesma lógica de `GET /api/comparativos/curva-abc`). Só envia se `email_semanal` estiver ligado e houve pedido no período |
| 2ª 08:00 | `syncNotionTarefas` | avalia anúncios ativos com 0 vendas/30d (estoque parado) e 1-3 vendas/30d (baixo); cria tarefas no Notion database (`NOTION_DATABASE_ID`). Anti-duplicata via busca por MLB antes de criar. Máx 20 parados + 10 baixos por execução. Rate-limit de 400ms entre chamadas Notion. Requer `NOTION_TOKEN` + `NOTION_DATABASE_ID` no `.env`; sem esses, loga aviso e retorna `not_configured` |
| a cada 4h (00/04/08/12/16/20h) | `syncTopVendas` | **não chama a API do ML** — só consulta `vw_ml_orders`/`vw_ml_stores` (dado já sincronizado via webhook) e envia ao Telegram (`tg_topvendas`) o top 5 itens mais vendidos (por unidades) nas últimas 4h, com nome da loja. Não notifica se não houve venda no período. Ver `business-rules.md` |

Todos (exceto `resumoDiario`, `emailDailyReports`, `emailRelatorioSemanal` e `tokenRefreshLoop`) são registrados em `schedule_jobs`/`schedule_runs` via `recordSync(name, cron, fn)` — consultável em `GET /api/schedule/jobs` e `GET /api/schedule/runs`. `syncTopVendas` usa `scheduleEvery(hours, fn, label)` (generalização de `scheduleAt` para jobs que rodam várias vezes ao dia, não só uma); `emailRelatorioSemanal` usa `scheduleWeekly(dayOfWeek, hour, minute, fn, label)` (mesma ideia, para jobs semanais) — ambos para o auto-reagendamento.

Outros loops independentes:
- `tokenRefreshLoop` — roda no boot e a cada 30 min; renova token se faltar <4h, alerta Telegram (`tg_token`) escalonado (a cada 6h se >48h, sempre se <4h). Tokens "epoch zero" (`token_expires_at < ano 2000`, ver `mercadolivre.md`) nunca são renovados automaticamente — só alerta, exige reconexão manual.
- `reprocessSkipped` — roda no boot (+5min) e a cada 30 min; reprocessa `webhook_logs` com `status='skipped'` e `topic='orders_v2'` das últimas 4h, respeitando o cooldown ainda ativo.
- Sync inicial automático de vendas 2 min após o boot, **só fora do horário de pico** (22h–08h) para não competir com tráfego de webhook.

## Eventos de outros marketplaces — v15/v16/v18 (`marketplaceEventWorker.js`, processo à parte do dispatch acima)

Desde v15, `worker.js` também sobe (2 linhas aditivas no final do arquivo, nenhum handler ML tocado) `marketplaceEventWorker.js`, que consome eventos padronizados de EventSources de marketplace — Amazon e, desde v18, Shopee. Este processo **não conhece** o dispatch table `handlers`/`processJob` do ML e vice-versa; são pipelines paralelos e independentes. Amazon e Shopee também são independentes entre si: filas BullMQ separadas (`marketplace-events-amazon`/`marketplace-events-shopee`), cada uma com seu próprio `Worker`, seu próprio mapa de clients (`clients`/`shopeeClients`) e seu próprio handler (`handleOrderEvent`/`handleShopeeOrderEvent`) — só compartilham o `Scheduler` genérico que dispara `discoverEvents()` de cada `EventSource` registrada.

- **Múltiplas contas (v16)**: no boot, `startMarketplaceEventWorkers()` busca todas as linhas de `stores` com `marketplace_id=AMAZON` (e, desde v18, `marketplace_id=SHOPEE`) e registra uma `EventSource` por conta — `AmazonPollingEventSource`/`ShopeePollingEventSource` — não uma instância fixa única. Os mapas `clients`/`shopeeClients` são chaveados por `stores.id`, não pelo código do marketplace.
- **Descoberta de eventos**: `server/src/marketplaces/Scheduler.js` orquestra todas as `EventSource`s registradas (`server/src/marketplaces/interfaces/EventSource.js`: `start/stop/discoverEvents`) — polling a cada 15 min pra Amazon e pra Shopee (fase 1; a Shopee suporta webhook — "Mecanismo de Empurra" — mas isso fica pra uma fase 2, ver `decisions.md`).
- Cada execução de `discoverEvents()` lê o cursor `last_synced_at` de `marketplace_sync_state` (chave `source_key = stores.id` daquela conta; 24h atrás na 1ª execução). A Amazon chama `AmazonClient.listRecentOrders`; a Shopee chama `ShopeeClient.listRecentOrders` (`order/get_order_list`, filtro `time_range_field=update_time`) — cada uma publica um evento por pedido na sua fila (`queues/marketplaceEventQueue.js`, uma fila por marketplace), com `jobId` estável (`AMAZON:ORDER_UPDATED:{storeId}-{orderId}` / `SHOPEE:ORDER_UPDATED:{storeId}-{orderSn}` — sempre 2 `:`, ver `known-bugs.md`) e o campo `storeId` no payload identificando de qual conta veio.
- **Renovação de token Shopee**: diferente da Amazon (`refresh_token` fixo), a Shopee **rotaciona** o `refresh_token` a cada renovação. `ShopeePollingEventSource._ensureValidToken()` renova proativamente (margem de 10min antes de expirar) e grava o novo par em `stores` com CAS (`WHERE refresh_token = <valor lido ao construir a instância>`) — mesmo padrão de `routes/auth.js` pro Mercado Livre — pra não sobrescrever um token mais novo salvo por outro processo em paralelo.
- **Consumo**: `Worker('marketplace-events-amazon', ...)`/`Worker('marketplace-events-shopee', ...)` usam `evt.storeId` para achar o `client` certo no mapa, buscam o pedido completo (`getOrder`), fazem upsert em `orders` (com `marketplace_id`, `store_id = evt.storeId`) e nos campos exclusivos em `amazon_order_data`/`shopee_order_data`, invalidam `kpis:summary` e publicam `order_updated` no WS — mesmo formato que o pipeline ML usa, para as telas do dashboard não precisarem saber a origem.
- **Mapeamento de status Shopee** (`mapShopeeStatus`): `READY_TO_SHIP`/`PROCESSED`/`SHIPPED`/`COMPLETED` → `paid` (a Shopee só libera pra embalar depois do pagamento confirmado); `CANCELLED`/`IN_CANCEL` → `cancelled`; `UNPAID` → `pending`.
- **Filtro de "loja ML" no restante de `worker.js`**: `startWorkers`, `tokenRefreshLoop`, `syncVendas`, `syncMetricas`, `syncParentItems`, `syncReturns`, `syncVisitas`, `syncScores` e os comandos `/status`/`/refresh` do bot filtram `WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')` — cobre qualquer quantidade de contas Amazon/Shopee automaticamente, não só um ID fixo (ver `decisions.md`).
- Notificação Telegram de vendas Amazon/Shopee **não está implementada** (fora de escopo — ver `todo.md`).
- Se as credenciais Amazon (`AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET`) ou Shopee (`SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY`) não estiverem configuradas, `discoverEvents()` é um no-op silencioso (mesma postura defensiva dos respectivos clients).

## Comandos manuais (canal Redis `worker:cmd`)

Aceita `{ cmd }` ∈ `dailySync`/`syncVendas`, `syncMetricas`, `syncReturns` (busca retroativa completa, não agendada), `syncParentItems`, `syncVisitas`, `syncPrecos`, `syncScores`, `syncNotionTarefas`, `syncTopVendas`, `emailDailyReports`, `emailRelatorioSemanal`, `checkOutlierEstatistico`, `reprocessSkipped`. Disparado por `POST /api/schedule/jobs/:name/trigger` ou `server/sync-now.sh`.

## Bot do Telegram (long polling)

`tgBotLoop` faz long polling em `getUpdates` (timeout 25s, se reagenda a cada 1s de intervalo entre chamadas). Não usa webhook do Telegram para comandos — só para replies de perguntas (`POST /webhooks/telegram`, ver `api.md`). Comandos suportados (`handleTgCommand`):

| Comando | Ação |
|---|---|
| `/status` | status de token de todas as lojas |
| `/refresh [nome]` | força refresh de token (todas as expiradas, ou busca parcial por nome) |
| `/sync vendas\|metricas\|visitas\|devolucoes\|topvendas\|email-diario\|email-semanal\|outlier` | dispara o sync correspondente |
| `/help`, `/start` | lista de comandos |

Notificações Telegram em geral (`tgNotify`) respeitam: flag por tópico em `app_config` (`tg_*` = `'false'` desativa), janela de silêncio (`silence_start`/`silence_end`, padrão 22:00–07:00) e intervalo mínimo entre envios do mesmo tópico (`tg_interval`, minutos). `tgNotifyForce` (usado por `syncVendas`, `syncMetricas`, `resumoDiario`) ignora essas regras — sempre envia.
