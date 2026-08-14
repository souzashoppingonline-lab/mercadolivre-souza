-- v77: Rastreamento de quando o card entrou em MONITORAMENTO
-- Permite contar dias desde a entrada em monitoramento, não desde o started_at original

ALTER TABLE ranking_ads ADD COLUMN monitoramento_started_at TIMESTAMPTZ;

CREATE INDEX idx_ranking_ads_monitoramento_started_at ON ranking_ads(monitoramento_started_at);
