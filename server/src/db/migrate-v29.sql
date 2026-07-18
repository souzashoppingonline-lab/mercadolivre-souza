-- v29: Conciliação Bancária — Fase 1 (só dados novos a partir de agora, sem backfill)
-- ml_payments: persiste o retorno de /collections/:id (já buscado em handlePayment,
--   antes descartado depois de extrair o order_id).
-- ml_billing_charges: cobranças oficiais de tarifa via /billing/integration/.../details
--   (ML e MP), só do período em aberto atual — auditoria de orders.ml_fee. Sem tabela
--   de cursor: o job relê a 1ª página do período aberto a cada execução e usa
--   ON CONFLICT (detail_id) DO NOTHING (idempotente) — evita depender de uma premissa
--   não confirmada sobre a semântica/ordenação do parâmetro last_id dessa API.

CREATE TABLE IF NOT EXISTS ml_payments (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT UNIQUE NOT NULL,
  order_id TEXT REFERENCES orders(ml_id),
  store_id BIGINT REFERENCES stores(id),
  status TEXT,
  status_detail TEXT,
  transaction_amount NUMERIC,
  date_created TIMESTAMPTZ,
  date_approved TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ml_payments_order_id ON ml_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_ml_payments_store_id ON ml_payments(store_id);
CREATE INDEX IF NOT EXISTS idx_ml_payments_status ON ml_payments(status);

CREATE TABLE IF NOT EXISTS ml_billing_charges (
  id BIGSERIAL PRIMARY KEY,
  detail_id BIGINT UNIQUE NOT NULL,
  store_id BIGINT REFERENCES stores(id),
  billing_group TEXT NOT NULL,          -- 'ML' | 'MP'
  period_key TEXT,
  transaction_detail TEXT,              -- descrição em português vinda da API (ex: "Tarifa por campanha de publicidade")
  detail_type TEXT,                     -- ex: 'CHARGE'
  detail_sub_type TEXT,                 -- código curto (ex: 'PADS', 'CFWA')
  detail_amount NUMERIC,
  creation_date_time TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ml_billing_charges_store ON ml_billing_charges(store_id);
CREATE INDEX IF NOT EXISTS idx_ml_billing_charges_group ON ml_billing_charges(billing_group);
