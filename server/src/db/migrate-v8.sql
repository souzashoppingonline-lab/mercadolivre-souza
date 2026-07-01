-- Migration v8 — store_metrics (reputação diária) + price_history (histórico de preços)

CREATE TABLE IF NOT EXISTS store_metrics (
  id SERIAL PRIMARY KEY,
  store_id BIGINT NOT NULL,
  level_id TEXT,
  power_seller_status TEXT,
  transactions_completed INT DEFAULT 0,
  positive_ratings_pct NUMERIC DEFAULT 0,
  negative_ratings_pct NUMERIC DEFAULT 0,
  neutral_ratings_pct NUMERIC DEFAULT 0,
  collected_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_metrics_store ON store_metrics(store_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  old_price NUMERIC,
  new_price NUMERIC,
  changed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_item ON price_history(item_id, changed_at DESC);
