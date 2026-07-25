-- v47: múltiplas lojas Shopee — chaves compostas em chat/custo/promoções/devoluções.
-- Permite que 2+ lojas Shopee sincronizem sem colisão de PRIMARY KEY.
-- Padrão idempotente: DROP CONSTRAINT IF EXISTS antes de cada ADD (Postgres NÃO
-- suporta "ADD CONSTRAINT IF NOT EXISTS", por isso o drop-then-add).
-- Onde store_id entra numa PRIMARY KEY, faz backfill dos NULLs antes (PK exige NOT NULL).

-- shopee_chat: conversation_id deixa de ser PK; PK vira surrogate (id) + UNIQUE (conversation_id, store_id).
ALTER TABLE shopee_chat DROP CONSTRAINT IF EXISTS shopee_chat_pkey;
ALTER TABLE shopee_chat ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE shopee_chat ADD CONSTRAINT shopee_chat_pkey PRIMARY KEY (id);
ALTER TABLE shopee_chat DROP CONSTRAINT IF EXISTS shopee_chat_unique_conv_store;
ALTER TABLE shopee_chat ADD CONSTRAINT shopee_chat_unique_conv_store UNIQUE (conversation_id, store_id);

-- shopee_item_cost: adiciona store_id à PK (item_id, model_id) → (item_id, store_id, model_id).
ALTER TABLE shopee_item_cost ADD COLUMN IF NOT EXISTS store_id BIGINT;
-- backfill: cada custo pertence a um item, e cada item a uma loja (via catálogo)
UPDATE shopee_item_cost c SET store_id = d.store_id
  FROM shopee_item_data d
  WHERE c.item_id = d.item_id AND c.store_id IS NULL;
-- sobra (item fora do catálogo): atribui à primeira loja Shopee cadastrada
UPDATE shopee_item_cost SET store_id = (
    SELECT id FROM stores
    WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'SHOPEE')
    ORDER BY id LIMIT 1)
  WHERE store_id IS NULL;
-- se ainda NULL (nenhuma loja Shopee), o custo é inutilizável na PK composta → remove
DELETE FROM shopee_item_cost WHERE store_id IS NULL;
ALTER TABLE shopee_item_cost DROP CONSTRAINT IF EXISTS shopee_item_cost_pkey;
ALTER TABLE shopee_item_cost ADD CONSTRAINT shopee_item_cost_pkey PRIMARY KEY (item_id, store_id, model_id);

-- shopee_promotions: adiciona store_id à PK (tipo, promo_id) → (tipo, promo_id, store_id).
ALTER TABLE shopee_promotions ADD COLUMN IF NOT EXISTS store_id BIGINT;
UPDATE shopee_promotions SET store_id = (
    SELECT id FROM stores
    WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'SHOPEE')
    ORDER BY id LIMIT 1)
  WHERE store_id IS NULL;
DELETE FROM shopee_promotions WHERE store_id IS NULL;
ALTER TABLE shopee_promotions DROP CONSTRAINT IF EXISTS shopee_promotions_pkey;
ALTER TABLE shopee_promotions ADD CONSTRAINT shopee_promotions_pkey PRIMARY KEY (tipo, promo_id, store_id);

-- shopee_returns: return_sn deixa de ser PK; PK vira surrogate (id) + UNIQUE (return_sn, store_id).
ALTER TABLE shopee_returns DROP CONSTRAINT IF EXISTS shopee_returns_pkey;
ALTER TABLE shopee_returns ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE shopee_returns ADD CONSTRAINT shopee_returns_pkey PRIMARY KEY (id);
ALTER TABLE shopee_returns DROP CONSTRAINT IF EXISTS shopee_returns_unique_sn_store;
ALTER TABLE shopee_returns ADD CONSTRAINT shopee_returns_unique_sn_store UNIQUE (return_sn, store_id);
