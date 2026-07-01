-- PostgreSQL schema — single source of truth for the dashboard.
-- Populated exclusively by BullMQ workers reacting to ML webhooks.

CREATE TABLE IF NOT EXISTS stores (
  id BIGINT PRIMARY KEY,
  nickname TEXT,
  level_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  active_listings INT DEFAULT 0,
  monthly_revenue NUMERIC DEFAULT 0,
  imposto_pct NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  ml_id TEXT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  title TEXT,
  price NUMERIC,
  available_quantity INT,
  sold_quantity INT,
  status TEXT,
  category_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  ml_id BIGINT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  buyer_nickname TEXT,
  title TEXT,
  total_amount NUMERIC,
  status TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  date_created TIMESTAMPTZ,
  date_closed TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  ml_id BIGINT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT,
  item_title TEXT,
  text TEXT,
  answer_text TEXT,
  status TEXT,
  date_created TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  pack_id TEXT,
  buyer_nickname TEXT,
  last_message TEXT,
  unread INT DEFAULT 0,
  last_message_date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS returns (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  order_id BIGINT REFERENCES orders(ml_id),
  title TEXT,
  reason TEXT,
  amount NUMERIC,
  status TEXT,
  date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  resource TEXT NOT NULL,
  store_id BIGINT,
  status TEXT DEFAULT 'pending', -- pending | processed | failed
  error TEXT,
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schedule_jobs (
  name TEXT PRIMARY KEY,
  cron TEXT,
  last_run TIMESTAMPTZ,
  duration_ms INT,
  status TEXT DEFAULT 'idle' -- idle | running | success | error
);

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

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  old_price NUMERIC,
  new_price NUMERIC,
  changed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date_created);
CREATE INDEX IF NOT EXISTS idx_items_store_status ON items(store_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_topic ON webhook_logs(topic);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status);
CREATE TABLE IF NOT EXISTS item_visits (
  id SERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  visits INT DEFAULT 0,
  date DATE NOT NULL,
  collected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_id, date)
);

CREATE INDEX IF NOT EXISTS store_metrics_store ON store_metrics(store_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS price_history_item ON price_history(item_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS item_visits_item ON item_visits(item_id, date DESC);
CREATE INDEX IF NOT EXISTS item_visits_store ON item_visits(store_id, date DESC);
