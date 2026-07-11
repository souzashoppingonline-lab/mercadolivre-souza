# Banco de Dados — PostgreSQL

> Escopo: schema completo, migrations e convenções de acesso ao Postgres. Única fonte de verdade sobre tabelas/colunas — outros arquivos apenas citam nomes de tabela, sem repetir a lista de colunas. **Sempre que uma migration for criada/alterada, atualize este arquivo na mesma tarefa.**

## Convenções

- Todo acesso passa por `server/src/db/pool.js` (singleton `pg.Pool`).
- Só o **worker** escreve nas tabelas alimentadas por webhook (`orders`, `items`, `questions`, `messages`, `returns`, `item_changes`, `promotions`, `price_history`, `item_visits`, `store_metrics`, `item_performance`). As rotas REST (`routes/api.js`) fazem apenas leitura dessas tabelas, exceto endpoints explícitos de configuração manual (custo, imposto, frete do vendedor, notas de devolução) — listados em `api.md`.
- `ml_turbo_sales` é populada por upload manual de planilha (`routes/turbo.js`), não pelo worker.
- Migrations são SQL puro, idempotentes (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), aplicadas em ordem por `db/migrate.js`.

## Como migrar

```bash
cd server
node src/db/migrate.js
```

Arquivos aplicados, em ordem (lista em `db/migrate.js`): `schema.sql`, `migrate-v2.sql`, `v3`, `v4`, `v8`, `v9`, `v11`, `v12`, `v13`, `v14`, `v15`.

> **v5, v6, v7 e v10 não estão na lista de `migrate.js`** — o conteúdo delas (tabela `app_config`, tabela `promotions`, coluna `stores.imposto_pct`, índice único `messages.pack_id`) já foi incorporado em `schema.sql` diretamente. Os arquivos `migrate-v5.sql` a `migrate-v7.sql` e `migrate-v10.sql` continuam no repositório como registro histórico, mas rodar `migrate.js` do zero não depende deles. Ver `known-bugs.md` para o risco disso em bancos legados que nunca rodaram esses arquivos.

## Tabelas

### `marketplaces` — v15: catálogo de marketplaces suportados
```
id SERIAL PK, code TEXT UNIQUE  -- 'ML' | 'AMAZON' | 'SHOPEE' | 'MAGALU' | 'TIKTOK'
name TEXT, api_type TEXT        -- 'webhook' | 'polling'
enabled BOOLEAN DEFAULT true
created_at TIMESTAMPTZ
```
Referenciada por `marketplace_id` em `stores`/`orders`/`items`/`messages` (coluna discriminadora, v15). Todo dado pré-existente foi backfillado para `code='ML'`. Ver `decisions.md` ("Marketplace Engine — schema evolutivo").

### `stores` — lojas/contas autorizadas por marketplace (suporta múltiplas contas por marketplace — v16)
```
id BIGINT PK              -- user_id do Mercado Livre; para Amazon/Shopee, um id sintético por conta
                           -- (convenção: sentinela original 9000000001, próximas contas 9000000002...)
nickname TEXT
level_id TEXT
access_token, refresh_token TEXT  -- refresh_token também usado pela Amazon (por conta)
amazon_marketplace_id TEXT  -- v16: override por conta (país/marketplace Amazon); NULL usa AMAZON_MARKETPLACE_ID global
amazon_region TEXT          -- v16: override por conta (na|eu|fe); NULL usa AMAZON_REGION global
token_expires_at TIMESTAMPTZ
active_listings INT, monthly_revenue NUMERIC   -- não populados automaticamente hoje
imposto_pct NUMERIC DEFAULT 0                  -- % de imposto usada no cálculo de margem
ml_client_id, ml_client_secret TEXT            -- credenciais próprias por loja (opcional)
refresh_failures INT DEFAULT 0                 -- v11: contagem de falhas consecutivas de refresh
last_refresh_error TEXT                        -- v11
marketplace_id INT FK marketplaces             -- v15
updated_at TIMESTAMPTZ
```

### `items` — anúncios
```
ml_id TEXT PK
store_id BIGINT FK stores
title, price, available_quantity, sold_quantity, status, category_id
thumbnail, permalink TEXT
cost NUMERIC DEFAULT 0            -- custo unitário (editável manualmente)
original_price NUMERIC DEFAULT 0  -- v13: preço "de" quando em promoção
parent_item_id TEXT               -- item pai (variações) — preenchido por syncParentItems
marketplace_id INT FK marketplaces -- v15
updated_at TIMESTAMPTZ
```

### `orders` — pedidos (fonte webhook/polling-driven, não confundir com `ml_turbo_sales`)
```
ml_id TEXT PK                     -- v15: era BIGINT; convertido para TEXT porque IDs de pedido
                                   -- de outros marketplaces (ex: Amazon "902-1845936-3456781")
                                   -- não são numéricos. Continua chamado `ml_id` por ora (débito
                                   -- técnico consciente — ver decisions.md) mesmo guardando IDs
                                   -- de outros marketplaces.
store_id BIGINT FK stores
buyer_nickname, item_id, title TEXT
quantity INT, unit_price NUMERIC, total_amount NUMERIC
ml_fee NUMERIC                    -- tarifa de venda ML
shipping_type TEXT, shipping_cost NUMERIC          -- frete pago pelo comprador
shipping_seller_cost NUMERIC DEFAULT 0             -- v4: frete pago pelo vendedor (entrada manual)
status TEXT, cancelled_by TEXT, cancel_reason TEXT
date_created, date_closed TIMESTAMPTZ
raw_data JSONB                    -- payload completo do pedido (só preenchido pelo pipeline ML)
marketplace_id INT FK marketplaces -- v15
updated_at TIMESTAMPTZ
```
Campos exclusivos de cada marketplace **não** ficam em `orders` — vão para uma tabela auxiliar por marketplace (`amazon_order_data` hoje). `orders` só guarda os campos comuns entre marketplaces.

### `questions` — perguntas de compradores
```
ml_id BIGINT PK
store_id BIGINT FK stores
item_id, item_title, text, answer_text, status TEXT
date_created, updated_at TIMESTAMPTZ
tg_message_id  -- referenciado em worker.js para permitir responder via reply no Telegram,
               -- MAS NÃO EXISTE em nenhuma migration. Ver known-bugs.md.
```

### `messages` — mensagens pós-venda
```
id BIGSERIAL PK
store_id BIGINT FK stores
pack_id TEXT              -- índice único (v10: messages_pack_id_unique)
buyer_nickname, last_message TEXT
unread INT DEFAULT 0      -- incrementado a cada mensagem nova do mesmo pack
marketplace_id INT FK marketplaces -- v15
last_message_date, updated_at TIMESTAMPTZ
```

### `returns` — devoluções/reclamações
```
id BIGSERIAL PK
store_id BIGINT FK stores
order_id TEXT FK orders   -- v15: acompanha a conversão de orders.ml_id para TEXT
buyer_nickname TEXT
title, reason, status TEXT
amount NUMERIC
date, updated_at TIMESTAMPTZ
note  -- usado pelo endpoint PATCH /api/alertas/devolucoes/:id/note (anotação manual do time)
```

### `amazon_order_data` — v15: campos exclusivos de pedidos Amazon
```
order_id TEXT PK FK orders(ml_id)
amazon_order_id TEXT NOT NULL  -- índice único; hoje é sempre igual a order_id
seller_id TEXT
fulfillment_channel, order_type TEXT
raw_data JSONB                 -- resposta completa da Orders API (SP-API)
updated_at TIMESTAMPTZ
```
Gravada por `server/src/marketplaceEventWorker.js`. Mesmo papel do `orders.raw_data` no pipeline ML, mas isolada — `orders` continua marketplace-agnóstica.

### `marketplace_sync_state` — v15: cursor de "última sincronização" para EventSources de polling
```
marketplace_id INT FK marketplaces, source_key TEXT   -- PK composta
last_synced_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```
Usada por `AmazonPollingEventSource` (`source_key='default'`, única conta configurada hoje). **Não confundir** com `schedule_jobs`/`schedule_runs` — aquelas guardam status/histórico de execução de cron; esta guarda um cursor de dados (até quando já foi sincronizado).

### `webhook_logs` — auditoria de todo webhook recebido
```
id BIGSERIAL PK
topic, resource TEXT NOT NULL
store_id BIGINT
status TEXT DEFAULT 'pending'   -- pending | processed | failed | skipped
error TEXT
received_at, processed_at TIMESTAMPTZ
```
`status='skipped'` ocorre quando o worker está em cooldown de 429 para aquele tópico+loja (ver `workers.md`).

### `schedule_jobs` — estado atual de cada sync agendado (1 linha por job)
```
name TEXT PK, cron TEXT, last_run TIMESTAMPTZ, duration_ms INT, status TEXT
```

### `schedule_runs` — histórico de execuções (v12)
```
id SERIAL PK, job_name TEXT, started_at/finished_at TIMESTAMPTZ, duration_ms INT
status TEXT, report JSONB, error_msg TEXT
```

### `store_metrics` — snapshot diário de reputação
```
id SERIAL PK, store_id BIGINT, level_id, power_seller_status TEXT
transactions_completed INT
positive/negative/neutral_ratings_pct NUMERIC
collected_at TIMESTAMPTZ
```

### `price_history` — mudanças de preço por item
```
id SERIAL PK, store_id BIGINT, item_id TEXT
old_price, new_price NUMERIC, changed_at TIMESTAMPTZ
```

### `item_visits` — visitas diárias por anúncio
```
id SERIAL PK, store_id BIGINT, item_id TEXT
visits INT, date DATE
UNIQUE(item_id, date)
```

### `item_changes` — trilha de auditoria de alterações de anúncio
```
id SERIAL PK, item_id TEXT, store_id BIGINT
changes JSONB    -- array de { field, old, new }
changed_at TIMESTAMPTZ
```

### `item_performance` — score de qualidade do anúncio (v14)
```
id SERIAL PK, store_id BIGINT, item_id TEXT UNIQUE
score NUMERIC(5,2), level TEXT, level_wording TEXT
pending_count INT, buckets JSONB DEFAULT '[]'
calculated_at, synced_at TIMESTAMPTZ
```

### `promotions` — histórico de status de promoções por oferta
```
id SERIAL PK, store_id BIGINT, offer_id TEXT, item_id, item_title TEXT
status, previous_status TEXT
original_price, promo_price, discount_pct NUMERIC
changed_at TIMESTAMPTZ, raw_data JSONB
```

### `ml_turbo_sales` — fonte financeira oficial (planilha, não webhook)
25 colunas — ver `finance.md` para o significado de cada campo e o mapeamento de aliases da planilha. `sale_id` é `UNIQUE` (chave de upsert).

### `app_config` — configuração key/value (Telegram, etc.)
```
key TEXT PK, value TEXT DEFAULT '', updated_at TIMESTAMPTZ
```
Chaves usadas hoje: `telegram_bot_token`, `telegram_chat_id`, `tg_vendas`, `tg_servicos`, `tg_recursos`, `tg_reposicao`, `tg_perguntas`, `tg_mensagens`, `tg_promocoes`, `tg_devolucoes`, `tg_anuncios`, `tg_token`, `tg_fila`, `tg_429`, `tg_infra`, `tg_resumo`, `tg_interval`, `silence_start`, `silence_end`.

### `sku_costs` — custo por SKU (compartilhado entre lojas)
```
sku TEXT PK, cost NUMERIC DEFAULT 0, updated_at TIMESTAMPTZ
```
Ao salvar via `PATCH /api/custos/:sku`, o mesmo valor também é gravado em `items.cost` para o `ml_id` correspondente (join implícito por SKU == `ml_id` no uso atual — não há coluna `sku` em `items`).

## Índices relevantes

`orders(store_id, status)`, `orders(date_created)`, `items(store_id, status)`, `webhook_logs(topic)`, `webhook_logs(status)`, `item_changes(item_id, changed_at DESC)`, `item_changes(store_id, changed_at DESC)`, `store_metrics(store_id, collected_at DESC)`, `price_history(item_id, changed_at DESC)`, `item_visits(item_id, date DESC)`, `item_visits(store_id, date DESC)`, `ml_turbo_sales(sale_date DESC / account / sku / item_code / state / order_status)`, `promotions(store_id, changed_at DESC)`, `promotions(offer_id, changed_at DESC)`, `schedule_runs(job_name, started_at DESC)`, `item_performance(store_id)`, `item_performance(score)`, `orders(marketplace_id)`, `items(marketplace_id)`, `stores(marketplace_id)` (v15), `amazon_order_data(amazon_order_id)` único (v15).

## Relação `items.parent_item_id` (variações)

Anúncios com variações têm um item "pai" (`parent_item_id`). O worker preenche essa coluna via job noturno `syncParentItems` (multiget na API do ML, 20 IDs por lote). Consultas de performance/curva ABC agrupam por `COALESCE(parent_item_id, ml_id)` para não fragmentar vendas entre variações — ver `GET /produtos/performance` em `api.md`.
