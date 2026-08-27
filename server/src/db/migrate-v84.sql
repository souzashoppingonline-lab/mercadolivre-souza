-- v84: tarifa editável manualmente por pedido (fallback pro caso do
-- CONCILIACAO_TARIFA_LATERAL não corrigir 100% dos casos de "frete do
-- comprador vazando pra tarifa", ou qualquer outra divergência real vs. o
-- que o Mercado Livre mostra — pedido explícito do usuário). Maior
-- precedência de todas: se preenchida, vence Conciliação/ml_payments/ml_fee.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tarifa_manual NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tarifa_manual_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tarifa_manual_at TIMESTAMPTZ;

-- `vw_ml_orders` (schema.sql) é `SELECT * FROM orders ...` — o conjunto de
-- colunas de uma view fica CONGELADO no momento do CREATE, mesmo sendo
-- "SELECT *" (confirmado: ALTER TABLE depois não propaga pra view já
-- criada). `schema.sql` roda ANTES desta migration em migrate.js (é o 1º
-- arquivo da lista), então sem isto `o.tarifa_manual` (vendaMargem.js)
-- quebraria com "column does not exist" até o PRÓXIMO `npm run migrate`.
-- Mesma classe de gap que provavelmente afetou finance_synced (v82) e
-- qualquer coluna nova de orders/items/stores usada via view na MESMA
-- migração que a criou — ver known-bugs.md ("views SELECT * ficam
-- desatualizadas até o próximo migrate.js").
CREATE OR REPLACE VIEW vw_ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
