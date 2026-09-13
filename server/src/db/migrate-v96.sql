-- v96 — anúncios Shopee com violação de conteúdo (banidos pela Shopee).
-- Não fica em `items` porque o sync de catálogo (syncShopeeCatalog) só
-- busca item_status='NORMAL' — um item banido nunca aparece lá. Tabela
-- separada, preenchida por syncShopeeItemViolations (marketplaceEventWorker),
-- reaproveitando o MESMO client (listAllItems('BANNED') + getItemsBaseInfo)
-- já usado no sync de catálogo normal — nenhuma chamada nova à API.
CREATE TABLE IF NOT EXISTS shopee_item_violations (
  item_id TEXT NOT NULL,
  store_id BIGINT NOT NULL,
  title TEXT,
  thumbnail TEXT,
  item_status TEXT,           -- 'BANNED' (único status varrido hoje)
  raw JSONB,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_shopee_item_violations_store ON shopee_item_violations(store_id);
