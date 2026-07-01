-- Migration v3 — full order raw data + sku_costs table

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS raw_data JSONB;

CREATE TABLE IF NOT EXISTS sku_costs (
  sku  TEXT PRIMARY KEY,
  cost NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
