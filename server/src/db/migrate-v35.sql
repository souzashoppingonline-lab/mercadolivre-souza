-- v35 — rastreio (tracking number) por pedido Shopee.
-- A etiqueta Shopee traz o tracking (BR...) no QR, não o número do pedido.
-- Guardamos o tracking por pedido pra casar a etiqueta bipada com o pedido na
-- Embalagem (mesma estação do ML — ver .claude/embalagem.md / shopee.md).
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS tracking_number TEXT;
CREATE INDEX IF NOT EXISTS idx_shopee_order_data_tracking
  ON shopee_order_data(tracking_number) WHERE tracking_number IS NOT NULL;
