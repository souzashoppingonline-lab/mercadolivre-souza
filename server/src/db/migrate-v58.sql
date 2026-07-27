-- v58 — Monitoramento de concorrentes: snapshot DIÁRIO de cada MLB coletado.
-- Guarda o histórico (preço em 1º lugar) pra a página mostrar a evolução dentro
-- do card. O preço é o mais importante; também guardamos estoque, vendas
-- acumuladas + delta do dia, visitas, tipo de anúncio e frete. Um snapshot por
-- MLB por dia (UNIQUE ml_id+snap_date; re-rodar no mesmo dia atualiza).
-- Ver .claude/analise-produtos.md.
CREATE TABLE IF NOT EXISTS analise_monitor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ml_id TEXT NOT NULL,
  snap_date DATE NOT NULL DEFAULT CURRENT_DATE,
  preco NUMERIC,
  preco_original NUMERIC,
  status TEXT,
  available_quantity INT,
  sold_quantity INT,
  sold_delta INT,            -- vendas do período = sold_quantity − snapshot anterior
  visits_day INT,
  listing_type TEXT,         -- gold_pro (Premium) / gold_special (Clássico)
  logistic_type TEXT,        -- fulfillment=FULL / self_service=FLEX / cross_docking
  free_shipping BOOLEAN,
  health NUMERIC,
  catalog BOOLEAN,
  seller_id TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ml_id, snap_date)
);
CREATE INDEX IF NOT EXISTS idx_monitor_mlid_date ON analise_monitor_snapshots (ml_id, snap_date);

-- Liga/desliga o monitoramento por anúncio (só os com ml_id são monitoráveis).
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS monitorar BOOLEAN DEFAULT true;
-- Link do anúncio (permalink). O MLB continua na coluna ml_id; ambos passam a ser
-- editáveis à mão (permite monitorar concorrentes adicionados manualmente).
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS link TEXT;
