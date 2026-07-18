-- v31: Conciliação Bancária — campos adicionais confirmados no mesmo payload de
-- /collections/:id (já observados ao vivo, deixados de fora por engano na v30).

ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS payment_method_id TEXT;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS payment_type TEXT;
ALTER TABLE ml_payments ADD COLUMN IF NOT EXISTS installments INT;
