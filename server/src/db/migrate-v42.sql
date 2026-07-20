-- v42 — devoluções/reembolsos Shopee (Returns API), isolado. Alimenta o Painel
-- de Problemas (reclamações = devoluções abertas; reembolsos = últimos 30d) e o
-- alerta Telegram de devolução nova. Preenchida pelo job syncShopeeReturns.
CREATE TABLE IF NOT EXISTS shopee_returns (
  return_sn TEXT PRIMARY KEY,
  store_id BIGINT,
  order_sn TEXT,
  status TEXT,              -- REQUESTED/PROCESSING/ACCEPTED/CANCELLED/CLOSED/...
  reason TEXT,             -- código (CHANGE_MIND, ...)
  text_reason TEXT,        -- texto livre do comprador
  refund_amount NUMERIC,
  currency TEXT,
  buyer_username TEXT,
  item_id TEXT,
  item_name TEXT,          -- 1º item da devolução
  create_time BIGINT,      -- epoch s
  update_time BIGINT,
  raw JSONB,
  notified BOOLEAN DEFAULT false,  -- dedup do alerta Telegram
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopee_returns_store ON shopee_returns(store_id);
CREATE INDEX IF NOT EXISTS idx_shopee_returns_status ON shopee_returns(status);
CREATE INDEX IF NOT EXISTS idx_shopee_returns_create ON shopee_returns(create_time);
