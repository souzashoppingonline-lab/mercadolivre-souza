-- PostgreSQL schema — single source of truth for the dashboard.
-- Populated exclusively by BullMQ workers reacting to ML webhooks + scheduler jobs.
-- Run via: npm run migrate

CREATE TABLE IF NOT EXISTS stores (
  id              BIGINT PRIMARY KEY,
  nickname        TEXT,
  level_id        TEXT,
  access_token    TEXT,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  active_listings INT DEFAULT 0,
  monthly_revenue NUMERIC DEFAULT 0,
  reputation_data JSONB,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  ml_id              TEXT PRIMARY KEY,
  store_id           BIGINT REFERENCES stores(id),
  title              TEXT,
  price              NUMERIC,
  available_quantity INT,
  sold_quantity      INT DEFAULT 0,
  status             TEXT,
  category_id        TEXT,
  visits             INT DEFAULT 0,
  position           INT,
  updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  ml_id          BIGINT PRIMARY KEY,
  store_id       BIGINT REFERENCES stores(id),
  buyer_nickname TEXT,
  buyer_id       BIGINT,
  title          TEXT,
  total_amount   NUMERIC,
  status         TEXT,
  cancelled_by   TEXT,
  cancel_reason  TEXT,
  date_created   TIMESTAMPTZ,
  date_closed    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  ml_id         BIGINT PRIMARY KEY,
  store_id      BIGINT REFERENCES stores(id),
  item_id       TEXT,
  item_title    TEXT,
  text          TEXT,
  answer_text   TEXT,
  answered_at   TIMESTAMPTZ,
  status        TEXT,
  date_created  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                BIGSERIAL PRIMARY KEY,
  store_id          BIGINT REFERENCES stores(id),
  pack_id           TEXT,
  buyer_nickname    TEXT,
  last_message      TEXT,
  unread            INT DEFAULT 0,
  last_message_date TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS returns (
  id         BIGSERIAL PRIMARY KEY,
  store_id   BIGINT REFERENCES stores(id),
  order_id   BIGINT REFERENCES orders(ml_id),
  title      TEXT,
  reason     TEXT,
  amount     NUMERIC,
  status     TEXT,
  date       TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT REFERENCES stores(id),
  item_id     TEXT,
  title       TEXT,
  impressions BIGINT DEFAULT 0,
  clicks      INT DEFAULT 0,
  spend       NUMERIC DEFAULT 0,
  revenue     NUMERIC DEFAULT 0,
  date        DATE DEFAULT CURRENT_DATE,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  store_id     BIGINT,
  status       TEXT DEFAULT 'pending',
  error        TEXT,
  received_at  TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schedule_jobs (
  name        TEXT PRIMARY KEY,
  cron        TEXT,
  last_run    TIMESTAMPTZ,
  duration_ms INT,
  status      TEXT DEFAULT 'idle'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_store_status  ON orders(store_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_date          ON orders(date_created);
CREATE INDEX IF NOT EXISTS idx_orders_buyer         ON orders(buyer_nickname);
CREATE INDEX IF NOT EXISTS idx_items_store_status   ON items(store_id, status);
CREATE INDEX IF NOT EXISTS idx_items_sold           ON items(sold_quantity DESC);
CREATE INDEX IF NOT EXISTS idx_questions_status     ON questions(status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_topic   ON webhook_logs(topic);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status  ON webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_date    ON webhook_logs(received_at);
CREATE INDEX IF NOT EXISTS idx_ads_date             ON ads_campaigns(date);
