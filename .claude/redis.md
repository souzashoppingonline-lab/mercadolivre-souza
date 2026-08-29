# Redis

> Escopo: como o Redis é usado neste projeto — cliente, cache de leitura, canais de mensagens. BullMQ também roda sobre Redis, mas a modelagem das filas está documentada em `workers.md`; aqui só cobrimos a conexão compartilhada e os canais pub/sub.

## Cliente — `server/src/db/redis.js`

Singleton `ioredis` (`new Redis(env.redisUrl, { maxRetriesPerRequest: null })`), importado por `routes/api.js`, `ws/hub.js` (que faz `.duplicate()` para o subscriber — obrigatório no `ioredis`, uma conexão em modo subscribe não pode rodar outros comandos), e por `worker.js`/`queues/webhookQueue.js` (conexões próprias `IORedis` dedicadas às filas BullMQ, não o singleton de `db/redis.js`).

## Uso 1 — cache de leitura (`server/src/db/cached.js`)

Helper `cached(key, ttlSeconds, fn)`: tenta `redis.get(key)`; se houver hit, retorna o JSON parseado; senão executa `fn()`, grava com `redis.set(key, JSON, 'EX', ttlSeconds)` e retorna. **Extraído pra módulo próprio (v87)** quando `routes/bi.js` virou o 2º consumidor (antes vivia só como função local em `routes/api.js`) — nunca duplicar esta lógica, sempre `require('../db/cached')`. Erro dentro de `fn()` nunca é cacheado (propaga antes do `redis.set`).

Chaves em uso hoje:
| Chave | TTL | Invalidada por |
|---|---|---|
| `kpis:summary` | 30s | `handleOrder` (worker) via `redis.del('kpis:summary')` após todo insert/update de pedido |
| `kpis:{storeId}` | — | referenciada em `handleOrder` (`redis.del`) mas **nenhuma rota GET escreve/lê essa chave hoje** — ver `known-bugs.md` |
| `vendas:margem:<from>:<to>:<days>:<fc>` | 60s | **só TTL** — não invalida por `order_updated` (ver exceção abaixo) |
| `vendas:detalhado:<store>:<status>:<days>:<search>:<from>:<to>` | 60s | **só TTL** — idem |
| `bi:margem:narrativa:<days>:<store_id>:<category_id>:<date_from>:<date_to>` | 30min | **só TTL** — v87, `POST /api/bi/margem/narrativa`. Clicar de novo com o MESMO filtro dentro do TTL devolve a mesma análise (mesmo `gerado_em`) sem chamar o LLM de novo — economiza tokens/latência, a narrativa não é sensível ao segundo mais recente. Ver `business-rules.md` |

**Exceção consciente (cache só por TTL):** `vendas/margem`, `vendas/detalhado` e `bi/margem/narrativa` **não** são invalidados no `order_updated`/edição de dado de propósito — esse evento é frequente demais e zeraria o cache justamente sob carga (quando ele mais importa), e a narrativa da IA é sobre padrão do período, não sobre o segundo mais recente. `vendas/margem`/`vendas/detalhado` fazem `LATERAL` por pedido em `mp_account_movements`+`ml_payments` (60s limita a defasagem a no máximo 1 minuto); a narrativa custa tokens reais por chamada (30min). Ver `decisions.md`.

**Regra do projeto**: sempre que um worker gravar em uma tabela que alimenta um endpoint cacheado, ele deve invalidar (`redis.del`) a chave correspondente logo após o `INSERT`/`UPDATE` — salvo a exceção "só TTL" acima, deliberada. Ao adicionar um novo `cached(...)`, registre a chave nesta tabela.

## Uso 2 — pub/sub para WebSocket

Canal `ml:ws:broadcast` — mecanismo completo documentado em `websocket.md`. Aqui, apenas: é um canal Redis comum (`PUBLISH`/`SUBSCRIBE`), sem persistência — se não houver um servidor HTTP inscrito no momento do publish, a mensagem se perde (não há fila/replay).

## Uso 3 — canal de comandos manuais para o worker

Canal `worker:cmd` — o endpoint `POST /api/schedule/jobs/:name/trigger` (ver `api.md`) publica `{ cmd: <nome> }`; o worker está inscrito (`cmdSub.subscribe('worker:cmd')` em `worker.js`) e despacha para a função de sync correspondente. Mesmo mecanismo usado pelo script `server/sync-now.sh`. Lista completa de comandos aceitos em `workers.md`.

## BullMQ sobre Redis (nota de fronteira)

As filas BullMQ (`ml-webhooks-{storeId}`) também vivem no mesmo Redis (mesma `REDIS_URL`), mas usam conexões `ioredis` próprias com `enableOfflineQueue: false` e `maxRetriesPerRequest: null` (exigido pelo BullMQ). Não reutilizar o singleton `db/redis.js` para filas — cada `Worker`/`Queue` do BullMQ precisa da sua própria conexão dedicada. Detalhes de filas, concorrência e retries: `workers.md`.
