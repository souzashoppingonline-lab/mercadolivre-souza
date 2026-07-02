-- PostgreSQL schema — single source of truth for the dashboard.
-- Populated exclusively by BullMQ workers reacting to ML webhooks.

CREATE TABLE IF NOT EXISTS item_changes (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  store_id BIGINT,
  changes JSONB NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_changes_item ON item_changes(item_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS item_changes_store ON item_changes(store_id, changed_at DESC);

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
  thumbnail TEXT,
  permalink TEXT,
  cost NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS thumbnail TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS permalink TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS orders (
  ml_id BIGINT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  buyer_nickname TEXT,
  item_id TEXT,
  title TEXT,
  quantity INT DEFAULT 1,
  unit_price NUMERIC DEFAULT 0,
  total_amount NUMERIC,
  ml_fee NUMERIC DEFAULT 0,
  shipping_type TEXT DEFAULT '',
  shipping_cost NUMERIC DEFAULT 0,
  shipping_seller_cost NUMERIC DEFAULT 0,
  status TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  date_created TIMESTAMPTZ,
  date_closed TIMESTAMPTZ,
  raw_data JSONB,
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

CREATE TABLE IF NOT EXISTS ml_turbo_sales (
  id              SERIAL PRIMARY KEY,
  sale_id         TEXT        UNIQUE NOT NULL,
  cart_id         TEXT,
  buyer           TEXT,
  state           TEXT,
  item_code       TEXT,
  title           TEXT,
  account         TEXT,
  shipping_mode   TEXT,
  ads             NUMERIC     DEFAULT 0,
  sku             TEXT,
  sale_date       DATE,
  shipping_type   TEXT,
  unit_price      NUMERIC     DEFAULT 0,
  quantity        INT         DEFAULT 1,
  revenue         NUMERIC     DEFAULT 0,
  cost            NUMERIC     DEFAULT 0,
  tax             NUMERIC     DEFAULT 0,
  ml_fee          NUMERIC     DEFAULT 0,
  buyer_shipping  NUMERIC     DEFAULT 0,
  seller_shipping NUMERIC     DEFAULT 0,
  margin          NUMERIC     DEFAULT 0,
  margin_pct      NUMERIC     DEFAULT 0,
  order_status    TEXT,
  payment_status  TEXT,
  shipping_id     TEXT,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turbo_sale_date   ON ml_turbo_sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_turbo_account     ON ml_turbo_sales(account);
CREATE INDEX IF NOT EXISTS idx_turbo_sku         ON ml_turbo_sales(sku);
CREATE INDEX IF NOT EXISTS idx_turbo_item_code   ON ml_turbo_sales(item_code);
CREATE INDEX IF NOT EXISTS idx_turbo_state       ON ml_turbo_sales(state);
CREATE INDEX IF NOT EXISTS idx_turbo_order_status ON ml_turbo_sales(order_status);

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
CREATE INDEX IF NOT EXISTS promotions_store_day ON promotions(store_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS promotions_offer ON promotions(offer_id, changed_at DESC);
