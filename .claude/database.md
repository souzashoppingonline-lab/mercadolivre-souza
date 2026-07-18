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

Arquivos aplicados, em ordem (lista em `db/migrate.js`): `schema.sql`, `migrate-v2.sql`, `v3`, `v4`, `v8`, `v9`, `v11`, `v12`, `v13`, `v14`, `v15`, `v16`, `v17`, `v18`, `v19`, `v20`, `v21`, `v22`, `v23`, `v24`, `v25`, `v26`, `v27`, `v28`, `v29`.

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
id BIGINT PK              -- user_id do Mercado Livre; para Amazon, id sintético 9000000001+;
                           -- para Shopee, id sintético 9100000001+ (faixa própria, nunca colide com a da Amazon)
nickname TEXT
level_id TEXT
access_token, refresh_token TEXT  -- reaproveitado por Amazon (refresh_token fixo) e Shopee (ambos rotacionam via OAuth)
amazon_marketplace_id TEXT  -- v16: override por conta (país/marketplace Amazon); NULL usa AMAZON_MARKETPLACE_ID global
amazon_region TEXT          -- v16: override por conta (na|eu|fe); NULL usa AMAZON_REGION global
shopee_shop_id BIGINT       -- v18: shop_id real da Shopee (numérico, único) — índice único parcial (WHERE NOT NULL)
token_expires_at TIMESTAMPTZ  -- Shopee: access_token expira em ~4h; refresh_token em ~30 dias (rotaciona a cada renovação)
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
shipping_id TEXT                  -- v21: ID do envio do ML (order.shipping.id), indexado, NÃO único
                                   -- (um envio/pack pode agrupar mais de um pedido). Chave de busca
                                   -- da bipagem de etiqueta — ver embalagem.md. Só populado a partir
                                   -- de pedidos processados depois da v21 (sem backfill retroativo).
shipping_status, shipping_substatus TEXT       -- v33: status cru de /shipments/:id (pending/handling/
                                   -- ready_to_ship/shipped/delivered/cancelled/not_delivered),
                                   -- persistidos por handleShipment (worker.js), casando por
                                   -- shipping_id (não raw_data->>'shipment_id' — mecanismo antigo,
                                   -- ver decisions.md). Usado na coluna "Entrega" da Conciliação
                                   -- Bancária — ver conciliacao-bancaria.md e business-rules.md
                                   -- (mapeamento status→emoji/cor).
date_ready_to_ship, date_shipped, date_delivered TIMESTAMPTZ  -- v33: de status_history do shipment
shipping_last_updated TIMESTAMPTZ -- v33: last_updated do shipment
updated_at TIMESTAMPTZ
```
Campos exclusivos de cada marketplace **não** ficam em `orders` — vão para uma tabela auxiliar por marketplace (`amazon_order_data`, `shopee_order_data`). `orders` só guarda os campos comuns entre marketplaces.

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
buyer_nickname TEXT       -- v23: existia em produção sem migration rastreada, corrigido (ver decisions.md)
title, reason, status TEXT
amount NUMERIC
date, updated_at TIMESTAMPTZ
note  -- v23 (mesma correção): usado pelo endpoint PATCH /api/alertas/devolucoes/:id/note (anotação manual do time)
raw_data JSONB  -- v24: claim completa da API do ML (stage/type/players/resolution/etc) — mesmo padrão de orders.raw_data
prejuizo NUMERIC  -- v28: valor de prejuízo digitado manualmente pelo usuário (R$ perdido com a devolução) — NÃO vem da API do ML, PATCH /api/alertas/devolucoes/:id/prejuizo. NULL = ainda não avaliado (distinto de prejuízo zero)
```

### `claim_reasons` — v24: cache de tradução de reason_id
```
id TEXT PK         -- ex: "PNR9509"
detail TEXT        -- descrição em português, ex: "Me arrependi da compra" (vem de GET /marketplace/v2/claims/reasons/:id)
flow TEXT
updated_at TIMESTAMPTZ
```
Populado sob demanda por `resolveClaimReason()` (`worker.js`) na primeira vez que um `reason_id` novo aparece — evita rechamar a API pro mesmo código toda vez (rate limit real observado). Sem FK pra `returns` — é join por `id = returns.reason` na leitura (`GET /api/alertas/devolucoes`).

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

### `shopee_order_data` — v18: campos exclusivos de pedidos Shopee
```
order_id TEXT PK FK orders(ml_id)
order_sn TEXT NOT NULL         -- índice único; hoje é sempre igual a order_id
shop_id BIGINT                 -- espelha stores.shopee_shop_id da conta dona do pedido
buyer_username TEXT
order_status TEXT              -- valor bruto da Shopee (UNPAID/READY_TO_SHIP/SHIPPED/COMPLETED/...), antes do mapeamento para orders.status
raw_data JSONB                 -- resposta completa de order/get_order_detail
updated_at TIMESTAMPTZ
```
Gravada por `server/src/marketplaceEventWorker.js` (`handleShopeeOrderEvent`), mesmo papel de `amazon_order_data`.

### `marketplace_sync_state` — v15: cursor de "última sincronização" para EventSources de polling
```
marketplace_id INT FK marketplaces, source_key TEXT   -- PK composta
last_synced_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```
Usada por `AmazonPollingEventSource`/`ShopeePollingEventSource` — `source_key = stores.id` (uma linha por conta, não mais `'default'` desde o suporte a múltiplas contas na v16). **Não confundir** com `schedule_jobs`/`schedule_runs` — aquelas guardam status/histórico de execução de cron; esta guarda um cursor de dados (até quando já foi sincronizado).

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

### `item_seo_score` — v25: SEO Score determinístico por anúncio (Qualidade de Anúncio, ML-only)
```
id SERIAL PK, store_id BIGINT FK stores, item_id TEXT UNIQUE FK items(ml_id)
category_id TEXT, brand TEXT
pictures_count INT, has_video BOOLEAN, title_length INT, description_word_count INT
has_gtin, has_brand, has_model BOOLEAN
is_full BOOLEAN, shipping_type TEXT           -- shipping_type é o valor bruto de item.shipping.logistic_type;
                                                -- is_full = (shipping_type === 'fulfillment')
catalog_listing BOOLEAN
required_attrs_total INT, required_attrs_missing INT, missing_required_attrs TEXT[]
visits_30d INT, sales_30d INT, conversion_rate NUMERIC
photos_score, video_score, title_score, description_score,
gtin_score, brand_score, model_score, full_score, catalog_score,
attributes_score, conversion_score, visits_score NUMERIC(5,2)  -- subscores individuais (auditoria/UI)
score NUMERIC(5,2)             -- soma ponderada final (ver business-rules.md, pesos normalizados)
calculated_at TIMESTAMPTZ
```
Populada 1x/dia pelo job `sync-seo-score` (`worker.js`, 04:30 — ver `workers.md`). `attributes_score` recebe nota máxima quando `required_attrs_total = 0` (categoria sem atributo obrigatório não deve penalizar o anúncio). Fórmula pura em `server/src/seoScore.js`, **nunca IA** — decisão explícita do usuário, ver `decisions.md`.

### `item_seo_score_history` — v25: série histórica do score, para o gráfico de evolução
```
id BIGSERIAL PK, item_id TEXT, store_id BIGINT
score NUMERIC(5,2), captured_at TIMESTAMPTZ DEFAULT now()
```
Um insert por item a cada execução do job `sync-seo-score` (append-only, sem upsert) — base de `GET /api/qualidade-anuncio/:itemId/historico` e `GET /api/qualidade-anuncio/historico-medio`.

### `category_attributes_cache` — v25: cache dos atributos obrigatórios por categoria ML
```
category_id TEXT PK, required_ids TEXT[], updated_at TIMESTAMPTZ DEFAULT now()
```
Populado sob demanda por `getRequiredAttrsForCategory()` (`worker.js`) a partir de `GET /categories/:id/attributes`, com TTL de 30 dias (`CATEGORY_ATTRS_CACHE_DAYS`) — evita rechamar a API pra mesma categoria em todo item durante o `sync-seo-score`. Mesmo padrão de cache-por-categoria já usado em `claim_reasons` (cache por código).

### `catalog_competition` — v26: Monitor de Buy-Box (concorrência de catálogo), 1 linha por item
```
id SERIAL PK, store_id BIGINT FK stores, item_id TEXT UNIQUE FK items(ml_id)
catalog_product_id TEXT
status TEXT               -- valor cru de price_to_win.status (ex: "competing"); "ganhando" é decidido
                           -- comparando winner_item_id = item_id, não por esta string (só um valor
                           -- confirmado ao vivo — ver decisions.md)
current_price, price_to_win NUMERIC
winner_item_id TEXT, winner_price NUMERIC
boosts_missing TEXT[]     -- ids dos boosts com status='opportunity' na resposta (ex: fulfillment, free_shipping)
consistent BOOLEAN, visit_share TEXT
calculated_at TIMESTAMPTZ
```
Escopo: só itens com `item_seo_score.catalog_listing = true` (v25) — subconjunto dos itens ativos. Populada 1x/dia pelo job `sync-catalog-competition` (`worker.js`, 04:50 — ver `workers.md`), 1 chamada por item (`GET /items/:id/price_to_win?version=v2`). **Não** guarda a lista de concorrentes (isso é buscado sob demanda, ver `api.md` — `GET /qualidade-anuncio/:itemId/concorrentes`). Ver `decisions.md` pro porquê deste módulo não usa busca por palavra-chave (API `/sites/MLB/search` bloqueada — 403 confirmado ao vivo).

### `catalog_competition_history` — v26: série histórica do status/preço de buy-box
```
id BIGSERIAL PK, item_id TEXT, store_id BIGINT
status TEXT, current_price, price_to_win NUMERIC
captured_at TIMESTAMPTZ DEFAULT now()
```
Um insert por item a cada execução do job `sync-catalog-competition` (append-only, mesmo padrão de `item_seo_score_history`).

### `promotions` — histórico de status de promoções por oferta
```
id SERIAL PK, store_id BIGINT, offer_id TEXT, item_id, item_title TEXT
status, previous_status TEXT
original_price, promo_price, discount_pct NUMERIC
changed_at TIMESTAMPTZ, raw_data JSONB
```

### `ml_turbo_sales` — fonte financeira oficial (planilha, não webhook)
25 colunas — ver `finance.md` para o significado de cada campo e o mapeamento de aliases da planilha. `sale_id` é `UNIQUE` (chave de upsert).

### `ml_payments` — v29/v30: pagamento por pedido (Conciliação Bancária, Fase 1)
```
id BIGSERIAL PK
payment_id BIGINT UNIQUE NOT NULL
order_id TEXT FK orders(ml_id)
store_id BIGINT FK stores
status, status_detail TEXT
transaction_amount NUMERIC
date_created, date_approved TIMESTAMPTZ
net_received_amount NUMERIC    -- v30: valor líquido (já com taxas descontadas)
money_release_date TIMESTAMPTZ -- v30: quando o Mercado Pago libera o dinheiro
released TEXT                  -- v30: valor cru da API ("no"/"yes")
marketplace_fee, mercadopago_fee, discount_fee, coupon_fee, finance_fee NUMERIC  -- v30
amount_refunded NUMERIC        -- v30
alert_notified_at TIMESTAMPTZ  -- v32: dedup do alerta Telegram de divergência (tg_conciliacao), mesmo padrão de tasks.overdue_notified_at
raw_data JSONB           -- resposta completa de /collections/:id
created_at, updated_at TIMESTAMPTZ
```
Gravada por `handlePayment` (`worker.js`) a cada webhook `payments` — antes esse handler só usava `/collections/:id` pra achar o `order_id` e descartava o resto. **Só dados novos a partir do deploy da v29, sem backfill de pagamentos antigos** (pedido explícito do usuário). **Os campos de liberação/taxa (v30) foram adicionados depois de confirmar ao vivo que `/collections/:id` já retorna `money_release_date`/`net_received_amount`/`released` — sem precisar de credencial Mercado Pago separada**, correção de uma suposição inicial errada (ver `decisions.md`). Job diário `sync-payment-releases` (`workers.md`) reconsulta pagamentos com `released != 'yes'`, já que essa transição não necessariamente gera um novo webhook do ML. Ver `conciliacao-bancaria.md`.

### `ml_billing_charges` — v29: cobrança oficial de tarifa ML/MP (Conciliação Bancária, Fase 1)
```
id BIGSERIAL PK
detail_id BIGINT UNIQUE NOT NULL
store_id BIGINT FK stores
billing_group TEXT       -- 'ML' | 'MP'
period_key TEXT           -- ex: '2026-07-01'
transaction_detail TEXT    -- descrição em português da API (ex: "Tarifa por campanha de publicidade")
detail_type TEXT            -- ex: 'CHARGE'
detail_sub_type TEXT         -- código curto (ex: 'PADS', 'CFWA')
detail_amount NUMERIC
creation_date_time TIMESTAMPTZ
raw_data JSONB
created_at TIMESTAMPTZ
```
Populada pelo job `syncBillingCharges` (`worker.js`, a cada 30min) via `GET /billing/integration/periods/key/{key}/group/{group}/details` — só o período em aberto atual, nunca período fechado/histórico. Sem tabela de cursor: relê a 1ª página a cada execução e usa `ON CONFLICT (detail_id) DO NOTHING` (idempotente) — decisão consciente de não depender da semântica não confirmada do cursor `last_id` dessa API. Sem coluna `order_id`: os campos `sales_info`/`shipping_info` que ligariam uma cobrança a uma venda específica vieram `null` em toda amostra observada até agora. Ver `conciliacao-bancaria.md`/`decisions.md`.

### `app_config` — configuração key/value (Telegram, etc.)
```
key TEXT PK, value TEXT DEFAULT '', updated_at TIMESTAMPTZ
```
Chaves usadas hoje: `telegram_bot_token`, `telegram_chat_id`, `tg_vendas`, `tg_servicos`, `tg_recursos`, `tg_reposicao`, `tg_perguntas`, `tg_mensagens`, `tg_promocoes`, `tg_devolucoes`, `tg_anuncios`, `tg_tarefas`, `tg_conciliacao`, `tg_token`, `tg_fila`, `tg_429`, `tg_infra`, `tg_resumo`, `tg_outlier`, `tg_topvendas`, `tg_interval`, `silence_start`, `silence_end`.

### `sku_costs` — custo por SKU (compartilhado entre lojas)
```
sku TEXT PK, cost NUMERIC DEFAULT 0, updated_at TIMESTAMPTZ
```
Ao salvar via `PATCH /api/custos/:sku`, o mesmo valor também é gravado em `items.cost` para o `ml_id` correspondente (join implícito por SKU == `ml_id` no uso atual — não há coluna `sku` em `items`).

### `tasks` — v19: cartões da Agenda Trello (Kanban), módulo independente
```
id BIGSERIAL PK
title TEXT NOT NULL, description TEXT
board_column TEXT DEFAULT 'a_fazer'  -- a_fazer | em_andamento | finalizado | excluido
priority TEXT DEFAULT 'media'        -- alta | media | baixa
marketplace_id INT FK marketplaces
store_id BIGINT FK stores
item_id TEXT                  -- referência solta (sem FK) a items.ml_id/orders.item_id —
                               -- a tarefa sobrevive mesmo se o anúncio for removido/alterado
source TEXT DEFAULT 'sistema' -- mercado_livre | amazon | shopee | sistema | manual
rule_key TEXT                 -- chave da regra automática que gerou o cartão (ex: 'estoque_critico',
                               -- 'score_baixo'); NULL em tarefas manuais — usada pelo TaskEngine pra
                               -- deduplicar (ver task-engine.md)
status TEXT DEFAULT 'aberto'  -- aberto | concluido
tags TEXT[] DEFAULT '{}'
assigned_to TEXT, due_date TIMESTAMPTZ  -- "Prazo" no frontend (pages/agenda-trello.html) — badge do card fica
                                        -- vermelho quando due_date < now() e board_column ainda aberto
overdue_notified_at TIMESTAMPTZ  -- v27: dedup do alerta Telegram de atraso (job checkTarefasAtrasadas,
                                  -- 08:15) — notifica 1x por vencimento, não repete todo dia. Resetado
                                  -- pra NULL sempre que due_date é alterado via PATCH (prazo adiado)
metadata JSONB DEFAULT '{}'   -- dados extras da regra automática (SKU, score, link do anúncio, etc.)
created_at, updated_at, completed_at TIMESTAMPTZ
```
Índice parcial `(rule_key, item_id) WHERE board_column != 'excluido'` (predicado ajustado na v20 — dedup agora bloqueia recriação em qualquer status que não seja Excluído, inclusive Finalizado; antes só bloqueava enquanto o cartão estava aberto) — dedup rápido do TaskEngine. Não reaproveita nenhuma tabela existente (`orders`/`items`) — módulo 100% independente, ver `task-engine.md`.

### `task_comments` — v19: comentários por cartão
```
id BIGSERIAL PK, task_id BIGINT FK tasks ON DELETE CASCADE
author TEXT, text TEXT NOT NULL
created_at TIMESTAMPTZ
```

### `packing_videos` — v21: vídeos de conferência de embalagem
```
id BIGSERIAL PK
shipping_id TEXT NOT NULL         -- mesma chave bipada da etiqueta (ver embalagem.md)
order_ids TEXT[] NOT NULL         -- pode ter mais de 1 (pack — vários pedidos no mesmo envio)
file_path TEXT NOT NULL           -- caminho absoluto em server/storage/embalagem-videos/ (fora do git)
duration_seconds INT
store_id BIGINT FK stores
created_at TIMESTAMPTZ
```
Sem FK entre `order_ids` e `orders.ml_id` (é `TEXT[]`, não dá pra fazer FK de array em Postgres) — a integridade é só de convenção, resolvida via `= ANY(order_ids)` nas queries. Apagado automaticamente (arquivo + linha) 30 dias após `created_at` pelo job `cleanupPackingVideos` (ver `workers.md`).

### `staff_users` — v22: login de acesso restrito (funcionários), ver `auth-staff.md`
```
id SERIAL PK
username TEXT UNIQUE NOT NULL
password_hash TEXT NOT NULL     -- bcrypt
role TEXT NOT NULL DEFAULT 'admin'   -- admin | embalagem
created_at TIMESTAMPTZ
```
Sem FK pra nenhuma outra tabela — módulo de autenticação totalmente isolado do domínio ML/Amazon/Shopee. Sem UI de gerenciamento; criar/atualizar usuário é via `server/scripts/createStaffUser.js`.

## Views ML-only (v17)

```sql
CREATE VIEW vw_ml_orders AS SELECT * FROM orders WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL;
CREATE VIEW vw_ml_items  AS SELECT * FROM items  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL;
CREATE VIEW vw_ml_stores AS SELECT * FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL;
```
Toda leitura (`FROM`/`JOIN`) em `routes/api.js` usa essas views em vez das tabelas diretamente — telas construídas só para o ML (a maioria hoje) não misturam pedidos/itens/lojas de outros marketplaces. Os `UPDATE`s pontuais (custo, imposto, frete vendedor) continuam direto nas tabelas reais, escopados por ID específico. Ver `decisions.md` ("Marketplace Engine — schema evolutivo", efeito colateral corrigido na v17).

## Índices relevantes

`orders(store_id, status)`, `orders(date_created)`, `items(store_id, status)`, `webhook_logs(topic)`, `webhook_logs(status)`, `item_changes(item_id, changed_at DESC)`, `item_changes(store_id, changed_at DESC)`, `store_metrics(store_id, collected_at DESC)`, `price_history(item_id, changed_at DESC)`, `item_visits(item_id, date DESC)`, `item_visits(store_id, date DESC)`, `ml_turbo_sales(sale_date DESC / account / sku / item_code / state / order_status)`, `promotions(store_id, changed_at DESC)`, `promotions(offer_id, changed_at DESC)`, `schedule_runs(job_name, started_at DESC)`, `item_performance(store_id)`, `item_performance(score)`, `orders(marketplace_id)`, `items(marketplace_id)`, `stores(marketplace_id)` (v15), `amazon_order_data(amazon_order_id)` único (v15), `stores(shopee_shop_id)` único parcial e `shopee_order_data(order_sn)` único (v18), `tasks(board_column)`, `tasks(source)`, `tasks(priority)`, `tasks(store_id)`, `tasks(rule_key, item_id)` parcial (v19, predicado ajustado na v20), `task_comments(task_id, created_at)` (v19), `orders(shipping_id)`, `packing_videos(shipping_id)`, `packing_videos(created_at)`, `packing_videos(order_ids)` GIN (v21), `staff_users(username)` único (v22), `item_seo_score(store_id)`, `item_seo_score(score)`, `item_seo_score(category_id)`, `item_seo_score_history(item_id, captured_at)` (v25), `catalog_competition(store_id)`, `catalog_competition(status)`, `catalog_competition_history(item_id, captured_at)` (v26).

## Relação `items.parent_item_id` (variações)

Anúncios com variações têm um item "pai" (`parent_item_id`). O worker preenche essa coluna via job noturno `syncParentItems` (multiget na API do ML, 20 IDs por lote). Consultas de performance/curva ABC agrupam por `COALESCE(parent_item_id, ml_id)` para não fragmentar vendas entre variações — ver `GET /produtos/performance` em `api.md`.
