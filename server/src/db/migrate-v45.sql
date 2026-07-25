-- v45: Corrigir constraints de múltiplas lojas Shopee (composite keys)
-- Problema: item_id em shopee_item_data era PRIMARY KEY simples
-- Causa: quando há 2+ lojas Shopee, o mesmo item_id aparece em ambas → violação de PK
-- Solução: PRIMARY KEY (item_id, store_id) composite

-- Recriar shopee_item_data com composite key
ALTER TABLE shopee_item_data DROP CONSTRAINT IF EXISTS shopee_item_data_pkey CASCADE;
ALTER TABLE shopee_item_data ADD COLUMN id BIGSERIAL PRIMARY KEY;
ALTER TABLE shopee_item_data ADD CONSTRAINT unique_shopee_item_store UNIQUE (item_id, store_id);

-- Garantir que store_id não é NULL (obrigatório para composite key)
ALTER TABLE shopee_item_data ALTER COLUMN store_id SET NOT NULL;

-- Corrigir tabela items: adicionar UNIQUE (ml_id, store_id) para Shopee/Amazon
-- Manter compatibilidade com ML que usa ml_id simples
ALTER TABLE items ADD CONSTRAINT unique_items_shopee_amazon UNIQUE (ml_id, store_id) WHERE marketplace_id IN (SELECT id FROM marketplaces WHERE code IN ('SHOPEE', 'AMAZON'));
