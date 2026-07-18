-- Status de Entrega na Conciliação Bancária
-- Campos de shipment persistidos localmente para a coluna "Entrega" da grid
-- (nunca consultar a API do ML no carregamento da página — ver conciliacao-bancaria.md).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_substatus TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_ready_to_ship TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_shipped TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_delivered TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_last_updated TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_shipping_status ON orders(shipping_status);
CREATE INDEX IF NOT EXISTS idx_orders_shipping_id_status ON orders(shipping_id, shipping_status);
