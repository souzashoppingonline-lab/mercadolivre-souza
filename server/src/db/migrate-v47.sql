-- v47: Shopee múltiplas lojas — composite keys para chat/promos/devoluções/custos
-- Permite que diferentes lojas Shopee sincronizem dados sem conflito de PRIMARY KEY.
-- O padrão é: id BIGSERIAL (PK interna) + UNIQUE (recurso_id, store_id).

-- shopee_chat: muda conversation_id de PK simples para UNIQUE composto com store_id
ALTER TABLE shopee_chat DROP CONSTRAINT IF EXISTS shopee_chat_pkey;
ALTER TABLE shopee_chat ADD COLUMN IF NOT EXISTS id BIGSERIAL PRIMARY KEY;
ALTER TABLE shopee_chat ADD CONSTRAINT IF NOT EXISTS shopee_chat_unique_conv_store UNIQUE (conversation_id, store_id);

-- shopee_item_cost: adiciona store_id ao PRIMARY KEY (item_id, model_id)
ALTER TABLE shopee_item_cost DROP CONSTRAINT IF EXISTS shopee_item_cost_pkey;
ALTER TABLE shopee_item_cost ADD COLUMN IF NOT EXISTS store_id BIGINT;
ALTER TABLE shopee_item_cost ADD CONSTRAINT IF NOT EXISTS shopee_item_cost_pkey PRIMARY KEY (item_id, store_id, model_id);

-- shopee_promotions: muda PRIMARY KEY (tipo, promo_id) para incluir store_id
ALTER TABLE shopee_promotions DROP CONSTRAINT IF EXISTS shopee_promotions_pkey;
ALTER TABLE shopee_promotions ADD CONSTRAINT IF NOT EXISTS shopee_promotions_pkey PRIMARY KEY (tipo, promo_id, store_id);

-- shopee_returns: muda return_sn de PK simples para UNIQUE composto com store_id
ALTER TABLE shopee_returns DROP CONSTRAINT IF EXISTS shopee_returns_pkey;
ALTER TABLE shopee_returns ADD COLUMN IF NOT EXISTS id BIGSERIAL PRIMARY KEY;
ALTER TABLE shopee_returns ADD CONSTRAINT IF NOT EXISTS shopee_returns_unique_sn_store UNIQUE (return_sn, store_id);
