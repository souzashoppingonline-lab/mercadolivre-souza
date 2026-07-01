-- Migration v6 — promotions tracking table
CREATE TABLE IF NOT EXISTS promotions (
  id              SERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  offer_id        TEXT NOT NULL,
  item_id         TEXT,
  item_title      TEXT,
  status          TEXT,
  previous_status TEXT,
  original_price  NUMERIC DEFAULT 0,
  promo_price     NUMERIC DEFAULT 0,
  discount_pct    NUMERIC DEFAULT 0,
  changed_at      TIMESTAMPTZ DEFAULT now(),
  raw_data        JSONB
);
CREATE INDEX IF NOT EXISTS promotions_store_day ON promotions(store_id, changed_at::date);
