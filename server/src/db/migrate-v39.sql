-- v39 — catálogo Shopee (Product API). Os campos COMUNS vão pra `items`
-- (title/price/available_quantity/status/category_id/thumbnail, reaproveitando
-- a tabela do ML), e os campos EXCLUSIVOS da Shopee (SKU, variações/models com
-- preço+estoque por SKU, descrição) ficam aqui — mesmo padrão de
-- shopee_order_data. Preenchida pelo job syncShopeeCatalog (marketplaceEventWorker).
CREATE TABLE IF NOT EXISTS shopee_item_data (
  item_id TEXT PRIMARY KEY,        -- = items.ml_id (item_id da Shopee, string)
  store_id BIGINT,
  item_sku TEXT,                   -- SKU pai
  has_model BOOLEAN DEFAULT false, -- true = tem variações (models)
  variation_count INT DEFAULT 0,
  price_min NUMERIC,               -- menor current_price entre as variações
  price_max NUMERIC,               -- maior current_price entre as variações
  stock_total INT DEFAULT 0,       -- soma do estoque disponível de todas as variações
  models JSONB,                    -- [{model_id, model_name, model_sku, current_price, original_price, stock, model_status}]
  tier_variation JSONB,            -- estrutura das variações (nome + opções + imagem)
  category_id BIGINT,
  description TEXT,
  raw JSONB,                       -- get_item_base_info bruto (referência)
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopee_item_data_store ON shopee_item_data(store_id);
