-- v32: Conciliação Bancária — dedup do alerta Telegram de divergência
-- (mesmo padrão de tasks.overdue_notified_at, v27) — notifica 1x por
-- pagamento, nunca repete o mesmo alerta todo dia.
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS alert_notified_at TIMESTAMPTZ;
