-- Busca por SKU na nova aba "Produtos/Anúncio" do Embalagem (GET
-- /api/embalagem/produtos/buscar) — SKU não é coluna direta de `items`,
-- vem do catálogo Shopee (shopee_item_data.item_sku) ou do snapshot do
-- pedido mais recente (orders.raw_data, ML). Índices pros dois caminhos.
CREATE INDEX IF NOT EXISTS idx_shopee_item_data_sku ON shopee_item_data(item_sku);
CREATE INDEX IF NOT EXISTS idx_orders_seller_sku ON orders ((raw_data->'order_items'->0->'item'->>'seller_sku'));
