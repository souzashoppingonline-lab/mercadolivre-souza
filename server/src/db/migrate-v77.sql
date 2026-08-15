-- v77: Rastreamento de quando o card entrou em MONITORAMENTO
-- Permite contar dias desde a entrada em monitoramento, não desde o started_at original
-- (v80: corrigido para ser idempotente — sem IF NOT EXISTS, toda reexecução do
--  migrate.js abortava este arquivo com "column already exists".)

ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS monitoramento_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ranking_ads_monitoramento_started_at ON ranking_ads(monitoramento_started_at);
