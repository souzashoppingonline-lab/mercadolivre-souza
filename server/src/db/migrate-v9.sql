-- Migration v9 — ml_turbo_sales: planilha do Mercado Turbo como fonte financeira oficial

CREATE TABLE IF NOT EXISTS ml_turbo_sales (
  id            SERIAL PRIMARY KEY,
  sale_id       TEXT        UNIQUE NOT NULL,
  cart_id       TEXT,
  buyer         TEXT,
  state         TEXT,
  item_code     TEXT,
  title         TEXT,
  account       TEXT,
  shipping_mode TEXT,
  ads           NUMERIC     DEFAULT 0,
  sku           TEXT,
  sale_date     DATE,
  shipping_type TEXT,
  unit_price    NUMERIC     DEFAULT 0,
  quantity      INT         DEFAULT 1,
  revenue       NUMERIC     DEFAULT 0,
  cost          NUMERIC     DEFAULT 0,
  tax           NUMERIC     DEFAULT 0,
  ml_fee        NUMERIC     DEFAULT 0,
  buyer_shipping  NUMERIC   DEFAULT 0,
  seller_shipping NUMERIC   DEFAULT 0,
  margin        NUMERIC     DEFAULT 0,
  margin_pct    NUMERIC     DEFAULT 0,
  order_status  TEXT,
  payment_status TEXT,
  shipping_id   TEXT,
  imported_at   TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turbo_sale_date  ON ml_turbo_sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_turbo_account    ON ml_turbo_sales(account);
CREATE INDEX IF NOT EXISTS idx_turbo_sku        ON ml_turbo_sales(sku);
CREATE INDEX IF NOT EXISTS idx_turbo_item_code  ON ml_turbo_sales(item_code);
CREATE INDEX IF NOT EXISTS idx_turbo_state      ON ml_turbo_sales(state);
CREATE INDEX IF NOT EXISTS idx_turbo_order_status ON ml_turbo_sales(order_status);
