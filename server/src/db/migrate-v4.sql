-- Migration v4 — seller shipping cost per order (manual entry)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_seller_cost NUMERIC DEFAULT 0;
