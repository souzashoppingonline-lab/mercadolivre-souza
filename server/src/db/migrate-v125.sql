-- v125: termômetro de reputação na Tela Telegram — store_metrics passa a
-- guardar as 3 taxas que o ML usa pra cor da reputação (reclamações, atraso
-- no envio, cancelamentos), em %. Preenchidas pelo sync-metricas (04:15).
ALTER TABLE store_metrics ADD COLUMN IF NOT EXISTS claims_pct NUMERIC;
ALTER TABLE store_metrics ADD COLUMN IF NOT EXISTS delayed_pct NUMERIC;
ALTER TABLE store_metrics ADD COLUMN IF NOT EXISTS cancellations_pct NUMERIC;
