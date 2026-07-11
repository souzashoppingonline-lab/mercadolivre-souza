-- PostgreSQL schema — single source of truth for the dashboard.
-- Populated exclusively by BullMQ workers reacting to ML webhooks.

-- Marketplace Engine — tabela discriminadora usada por marketplace_id em
-- stores/orders/items/messages (ver migrate-v15.sql e .claude/decisions.md).
CREATE TABLE IF NOT EXISTS marketplaces (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  api_type TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO marketplaces (code, name, api_type, enabled) VALUES
  ('ML',     'Mercado Livre', 'webhook', true),
  ('AMAZON', 'Amazon',        'polling', true),
  ('SHOPEE', 'Shopee',        'webhook', false),
  ('MAGALU', 'Magalu',        'polling', false),
  ('TIKTOK', 'TikTok',        'polling', false)
ON CONFLICT (code) DO NOTHING;

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
  ml_client_id TEXT,
  ml_client_secret TEXT,
  marketplace_id INT REFERENCES marketplaces(id),
  amazon_marketplace_id TEXT, -- override por conta Amazon; fallback AMAZON_MARKETPLACE_ID (.env) quando NULL
  amazon_region TEXT,         -- override por conta Amazon; fallback AMAZON_REGION (.env) quando NULL
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- Em bancos existentes, o CREATE TABLE acima é no-op — a coluna precisa
-- deste ALTER explícito para existir antes de qualquer INSERT/index que a use.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_marketplace_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_region TEXT;

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
  marketplace_id INT REFERENCES marketplaces(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS thumbnail TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS permalink TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS parent_item_id TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

-- ml_id é TEXT (não BIGINT) para caber IDs de pedido não-numéricos de
-- outros marketplaces (ex: Amazon "902-1845936-3456781"). Ver migrate-v15.sql.
CREATE TABLE IF NOT EXISTS orders (
  ml_id TEXT PRIMARY KEY,
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
  marketplace_id INT REFERENCES marketplaces(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

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
  marketplace_id INT REFERENCES marketplaces(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

CREATE TABLE IF NOT EXISTS returns (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  order_id TEXT REFERENCES orders(ml_id),
  title TEXT,
  reason TEXT,
  amount NUMERIC,
  status TEXT,
  date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Em bancos existentes, os CREATE TABLE acima são no-op (orders/returns já
-- existem) e não mudam o tipo de uma coluna já criada como BIGINT. A
-- conversão para TEXT precisa ser um ALTER explícito, feito ANTES de
-- qualquer tabela nova que faça FK para orders(ml_id) (ex: amazon_order_data
-- abaixo) — senão a FK falha por incompatibilidade de tipo. A constraint
-- precisa ser solta antes de alterar o tipo da coluna referenciada (Postgres
-- não permite alterar um lado sem o outro com a FK ativa) e recriada depois.
-- Todo o bloco é idempotente: em instalação nova ambos já são TEXT (no-op),
-- e reexecutar em bancos já migrados só recria a mesma constraint.
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_order_id_fkey;
ALTER TABLE orders  ALTER COLUMN ml_id    TYPE TEXT USING ml_id::TEXT;
ALTER TABLE returns ALTER COLUMN order_id TYPE TEXT USING order_id::TEXT;
ALTER TABLE returns ADD CONSTRAINT returns_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(ml_id);

-- Campos exclusivos de pedidos Amazon — orders continua só com campos comuns.
CREATE TABLE IF NOT EXISTS amazon_order_data (
  order_id TEXT PRIMARY KEY REFERENCES orders(ml_id),
  amazon_order_id TEXT NOT NULL,
  seller_id TEXT,
  fulfillment_channel TEXT,
  order_type TEXT,
  raw_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_order_data_amazon_id ON amazon_order_data(amazon_order_id);

-- Cursor de "última sincronização" para EventSources de polling (Amazon hoje).
CREATE TABLE IF NOT EXISTS marketplace_sync_state (
  marketplace_id INT NOT NULL REFERENCES marketplaces(id),
  source_key TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (marketplace_id, source_key)
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

CREATE TABLE IF NOT EXISTS schedule_runs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  status TEXT, -- success | error | running
  report JSONB,
  error_msg TEXT
);
CREATE INDEX IF NOT EXISTS schedule_runs_job ON schedule_runs(job_name, started_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_items_marketplace ON items(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_stores_marketplace ON stores(marketplace_id);

-- Store sentinela para a conta Amazon — só uma conta configurada via
-- server/.env hoje, sem descoberta dinâmica de lojas como o ML tem.
INSERT INTO stores (id, nickname, marketplace_id)
VALUES (9000000001, 'Amazon', (SELECT id FROM marketplaces WHERE code = 'AMAZON'))
ON CONFLICT (id) DO NOTHING;
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

-- Views ML-only — telas existentes (construídas só para o ML) leem daqui em
-- vez de orders/items/stores diretamente, para não misturar outros
-- marketplaces (Amazon) nos KPIs/relatórios. Ver migrate-v17.sql.
CREATE OR REPLACE VIEW ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW ml_stores AS
  SELECT * FROM stores
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
