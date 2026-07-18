-- Conciliação Bancária fase 2 — Relatórios de Conciliação do Mercado Pago.
-- mp_account_movements: cada linha do release_report (extrato/movimentações da
-- conta MP), casada por source_id=payment_id / order_id. Fonte da aba Extrato,
-- Saques bancários e da confirmação "transferido pro banco". Ver
-- conciliacao-bancaria.md e decisions.md.
CREATE TABLE IF NOT EXISTS mp_account_movements (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  movement_hash TEXT UNIQUE,          -- dedup entre relatórios com range sobreposto
  release_date TIMESTAMPTZ,
  source_id TEXT,                     -- payment_id / collection id (casa com ml_payments.payment_id)
  order_id TEXT,                      -- EXTERNAL_REFERENCE / ORDER_ID (casa com orders.ml_id)
  pack_id TEXT,
  shipping_id TEXT,
  record_type TEXT,                   -- Release / Initial available balance / Total
  description TEXT,                   -- Payment / Cash withdrawal / Refund / Mediation / Reserve for payout / ...
  net_credit_amount NUMERIC DEFAULT 0,
  net_debit_amount NUMERIC DEFAULT 0,
  gross_amount NUMERIC DEFAULT 0,
  mp_fee_amount NUMERIC DEFAULT 0,
  shipping_fee_amount NUMERIC DEFAULT 0,
  coupon_amount NUMERIC DEFAULT 0,
  balance NUMERIC,
  payment_method TEXT,
  sale_detail TEXT,
  report_file TEXT,                   -- arquivo de origem (auditoria)
  raw_line JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mp_mov_store ON mp_account_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_mp_mov_source ON mp_account_movements(source_id);
CREATE INDEX IF NOT EXISTS idx_mp_mov_order ON mp_account_movements(order_id);
CREATE INDEX IF NOT EXISTS idx_mp_mov_desc ON mp_account_movements(description);
CREATE INDEX IF NOT EXISTS idx_mp_mov_date ON mp_account_movements(release_date);

-- Controle de idempotência: cada arquivo de relatório é importado 1x só.
CREATE TABLE IF NOT EXISTS mp_reports_imported (
  store_id BIGINT,
  report_type TEXT,                   -- release_report | settlement_report
  file_name TEXT,
  row_count INT,
  imported_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store_id, file_name)
);
