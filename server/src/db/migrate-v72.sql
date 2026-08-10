-- v72 — Ciclos de rankeamento + métricas de ADS manuais no card.
-- Cada anúncio em rankeamento passa a ter um "ciclo" (1, 2, 3…). Quando o
-- usuário encerra o ciclo atual e começa o próximo, os números daquele ciclo
-- (ADS investido, ROAS, orçamento/dia, vendas e faturamento) são arquivados em
-- ranking_ciclos e o contador reinicia para o novo empurrão.
-- ADS investido / ROAS / orçamento diário são preenchidos MANUALMENTE no card
-- (o ML não expõe esses números por webhook). Ver .claude/rankeamento.md.

ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS ciclo INT DEFAULT 1;                 -- ciclo atual (1, 2, 3…)
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS ads_investido NUMERIC;               -- R$ investido em ADS no ciclo atual (manual)
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS roas NUMERIC;                         -- ROAS do ciclo atual (manual)
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS orcamento_diario NUMERIC;             -- orçamento diário de ADS (manual)
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS ciclo_iniciado_em TIMESTAMPTZ;        -- início do ciclo atual (escopo do faturamento do ciclo)

-- Backfill: cards já existentes ficam no ciclo 1 desde que entraram em
-- rankeamento (started_at) — assim o faturamento do ciclo não muda pra eles.
UPDATE ranking_ads SET ciclo_iniciado_em = COALESCE(started_at, created_at, now())
 WHERE ciclo_iniciado_em IS NULL;
ALTER TABLE ranking_ads ALTER COLUMN ciclo_iniciado_em SET DEFAULT now();

-- Histórico dos ciclos encerrados (um por ciclo finalizado ao "Novo ciclo").
CREATE TABLE IF NOT EXISTS ranking_ciclos (
  id SERIAL PRIMARY KEY,
  ranking_ad_id INT REFERENCES ranking_ads(id) ON DELETE CASCADE,
  ciclo INT NOT NULL,                  -- número do ciclo encerrado
  ads_investido NUMERIC,               -- ADS investido no ciclo (manual, snapshot)
  roas NUMERIC,                        -- ROAS informado no ciclo (snapshot)
  orcamento_diario NUMERIC,            -- orçamento/dia informado no ciclo (snapshot)
  sales_count INT,                     -- vendas contabilizadas no ciclo
  faturamento NUMERIC,                 -- faturamento do ciclo (soma dos ranking_events)
  iniciado_em TIMESTAMPTZ,             -- quando o ciclo começou
  encerrado_em TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_ciclos_ad ON ranking_ciclos(ranking_ad_id, ciclo DESC);
