-- v21 — Embalagem: bipagem de etiqueta (FLEX/Mercado Envios) + gravação de
-- vídeo de conferência. shipping_id em orders é a chave de busca (extraída
-- do QR/barcode da etiqueta — ver .claude/embalagem.md). Não é UNIQUE: um
-- mesmo envio (pack) pode agrupar mais de um pedido.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_shipping_id ON orders(shipping_id);

CREATE TABLE IF NOT EXISTS packing_videos (
  id BIGSERIAL PRIMARY KEY,
  shipping_id TEXT NOT NULL,
  order_ids TEXT[] NOT NULL,
  file_path TEXT NOT NULL,
  duration_seconds INT,
  store_id BIGINT REFERENCES stores(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_packing_videos_shipping ON packing_videos(shipping_id);
CREATE INDEX IF NOT EXISTS idx_packing_videos_created ON packing_videos(created_at);
CREATE INDEX IF NOT EXISTS idx_packing_videos_order_ids ON packing_videos USING GIN(order_ids);
