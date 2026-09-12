-- v95 — alerta granular de vencimento de campanha Shopee (descontos +
-- vouchers, shopee_promotions): 5/4/3/2/1 dias antes de vencer + 1x por dia
-- depois de vencida, por Telegram (tg_shopee_campanhas) E e-mail
-- (email_shopee_campanhas) — ver checkShopeeCampanhasVencendo em worker.js.
-- Substitui o alerta único <24h/Telegram-apenas que usava expiry_notified
-- (removido: nenhum outro código lia essa coluna).
ALTER TABLE shopee_promotions DROP COLUMN IF EXISTS expiry_notified;

-- Menor "dias restantes" já alertado (5,4,3,2,1) — evita repetir o mesmo
-- degrau; NULL = fora da janela de alerta ou nunca alertado.
ALTER TABLE shopee_promotions ADD COLUMN IF NOT EXISTS expiry_alert_min_days SMALLINT;

-- Data (America/Sao_Paulo) do último alerta "campanha vencida" — dedup pra
-- no máximo 1 alerta por dia por campanha vencida.
ALTER TABLE shopee_promotions ADD COLUMN IF NOT EXISTS expiry_alert_expired_date DATE;
