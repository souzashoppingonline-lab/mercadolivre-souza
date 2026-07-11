# Redis

> Escopo: como o Redis é usado neste projeto — cliente, cache de leitura, canais de mensagens. BullMQ também roda sobre Redis, mas a modelagem das filas está documentada em `workers.md`; aqui só cobrimos a conexão compartilhada e os canais pub/sub.

## Cliente — `server/src/db/redis.js`

Singleton `ioredis` (`new Redis(env.redisUrl, { maxRetriesPerRequest: null })`), importado por `routes/api.js`, `ws/hub.js` (que faz `.duplicate()` para o subscriber — obrigatório no `ioredis`, uma conexão em modo subscribe não pode rodar outros comandos), e por `worker.js`/`queues/webhookQueue.js` (conexões próprias `IORedis` dedicadas às filas BullMQ, não o singleton de `db/redis.js`).

## Uso 1 — cache de leitura (`routes/api.js`)

Helper `cached(key, ttlSeconds, fn)`: tenta `redis.get(key)`; se houver hit, retorna o JSON parseado; senão executa `fn()`, grava com `redis.set(key, JSON, 'EX', ttlSeconds)` e retorna.

Chaves em uso hoje:
| Chave | TTL | Invalidada por |
|---|---|---|
| `kpis:summary` | 30s | `handleOrder` (worker) via `redis.del('kpis:summary')` após todo insert/update de pedido |
| `kpis:{storeId}` | — | referenciada em `handleOrder` (`redis.del`) mas **nenhuma rota GET escreve/lê essa chave hoje** — ver `known-bugs.md` |

**Regra do projeto**: sempre que um worker gravar em uma tabela que alimenta um endpoint cacheado, ele deve invalidar (`redis.del`) a chave correspondente logo após o `INSERT`/`UPDATE`. Ao adicionar um novo `cached(...)` em `routes/api.js`, adicione também o `redis.del` correspondente no handler do worker que altera aquele dado, e registre a nova chave nesta tabela.

## Uso 2 — pub/sub para WebSocket

Canal `ml:ws:broadcast` — mecanismo completo documentado em `websocket.md`. Aqui, apenas: é um canal Redis comum (`PUBLISH`/`SUBSCRIBE`), sem persistência — se não houver um servidor HTTP inscrito no momento do publish, a mensagem se perde (não há fila/replay).

## Uso 3 — canal de comandos manuais para o worker

Canal `worker:cmd` — o endpoint `POST /api/schedule/jobs/:name/trigger` (ver `api.md`) publica `{ cmd: <nome> }`; o worker está inscrito (`cmdSub.subscribe('worker:cmd')` em `worker.js`) e despacha para a função de sync correspondente. Mesmo mecanismo usado pelo script `server/sync-now.sh`. Lista completa de comandos aceitos em `workers.md`.

## BullMQ sobre Redis (nota de fronteira)

As filas BullMQ (`ml-webhooks-{storeId}`) também vivem no mesmo Redis (mesma `REDIS_URL`), mas usam conexões `ioredis` próprias com `enableOfflineQueue: false` e `maxRetriesPerRequest: null` (exigido pelo BullMQ). Não reutilizar o singleton `db/redis.js` para filas — cada `Worker`/`Queue` do BullMQ precisa da sua própria conexão dedicada. Detalhes de filas, concorrência e retries: `workers.md`.
