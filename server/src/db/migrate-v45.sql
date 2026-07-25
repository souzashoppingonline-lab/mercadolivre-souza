-- v45: múltiplas lojas Shopee — chave composta em shopee_item_data + items.
-- Problema: item_id em shopee_item_data e ml_id em items eram únicos "sozinhos",
-- e o worker passou a usar ON CONFLICT (item_id, store_id) / (ml_id, store_id) para
-- suportar 2+ lojas. Sem um índice único casando exatamente essas colunas, o INSERT
-- falha com "no unique or exclusion constraint matching the ON CONFLICT specification".
-- Tudo idempotente (DROP IF EXISTS antes de cada ADD) para poder re-rodar sem quebrar.

-- shopee_item_data: troca PK simples (item_id) por PK surrogate (id) + UNIQUE (item_id, store_id).
ALTER TABLE shopee_item_data DROP CONSTRAINT IF EXISTS shopee_item_data_pkey;
ALTER TABLE shopee_item_data ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE shopee_item_data ADD CONSTRAINT shopee_item_data_pkey PRIMARY KEY (id);
ALTER TABLE shopee_item_data DROP CONSTRAINT IF EXISTS unique_shopee_item_store;
ALTER TABLE shopee_item_data ADD CONSTRAINT unique_shopee_item_store UNIQUE (item_id, store_id);

-- items: PK continua (ml_id) — é referenciada por FK em item_seo_score/catalog_competition,
-- então NÃO pode mudar. Só adiciona um índice único casando (ml_id, store_id) para servir
-- de árbitro ao ON CONFLICT (ml_id, store_id) da sincronização de catálogo Shopee/Amazon.
-- Como ml_id já é PK (único global), (ml_id, store_id) é sempre único — o índice nunca
-- adiciona restrição real, só existe para o ON CONFLICT funcionar.
CREATE UNIQUE INDEX IF NOT EXISTS items_ml_store_unique ON items (ml_id, store_id);
