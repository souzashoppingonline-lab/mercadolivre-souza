-- v49 — Print Agent: fila de impressão automática de etiquetas (10x15 térmica).
-- O operador bipa → o sistema enfileira um print_job → um agente rodando no PC da
-- expedição (autenticado por token de estação) puxa o PDF, imprime na impressora
-- USB (ex.: Elgin PRO FULL) e confirma. Ver .claude/print-agent.md.

-- Estação = um PC/impressora da expedição. Cada loja pode ter a sua (multi-estação).
CREATE TABLE IF NOT EXISTS print_stations (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  store_id      BIGINT REFERENCES stores(id),   -- loja que imprime nessa estação (NULL = qualquer)
  token         TEXT NOT NULL UNIQUE,           -- segredo do agente (Authorization por estação)
  printer_name  TEXT,                           -- nome da impressora no SO (ex.: "Elgin PRO FULL")
  last_seen     TIMESTAMPTZ,                    -- último contato do agente (heartbeat/poll)
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_stations_store ON print_stations(store_id);

-- Job de impressão. O PDF NÃO é guardado: é regerado sob demanda a partir de `label`
-- (mesmo payload do generateLabelPDF), então a tabela fica leve e determinística.
CREATE TABLE IF NOT EXISTS print_jobs (
  id           BIGSERIAL PRIMARY KEY,
  station_id   BIGINT REFERENCES print_stations(id),
  store_id     BIGINT REFERENCES stores(id),
  shipping_id  TEXT,                            -- etiqueta/rastreio bipado (referência)
  label        JSONB NOT NULL,                  -- {product_name, variation_type, sku, store_name, company_name}
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | printing | printed | error
  attempts     INT  NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  claimed_at   TIMESTAMPTZ,
  printed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_station_status ON print_jobs(station_id, status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
