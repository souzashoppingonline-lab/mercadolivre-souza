-- v30: Conciliação Bancária — correção de rota. Teste ao vivo (18/07/2026) provou que
-- /collections/:id (mesmo endpoint já usado, token ML existente, SEM app Mercado Pago
-- separado) já retorna money_release_date, net_received_amount, released e o
-- detalhamento de taxas — dado que a v29 assumia exigir credencial MP nova.
-- Ver .claude/decisions.md ("Conciliação Bancária — /collections/:id já tinha os campos").

ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS net_received_amount NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS money_release_date TIMESTAMPTZ;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS released TEXT;              -- valor cru da API ("no"/"yes")
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS marketplace_fee NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS mercadopago_fee NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS discount_fee NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS coupon_fee NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS finance_fee NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS amount_refunded NUMERIC;

CREATE INDEX IF NOT EXISTS idx_ml_payments_released ON ml_payments(released);
CREATE INDEX IF NOT EXISTS idx_ml_payments_money_release_date ON ml_payments(money_release_date);
