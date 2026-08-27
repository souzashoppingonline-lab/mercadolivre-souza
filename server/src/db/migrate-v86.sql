-- v86: edição manual do frete do vendedor por pedido, mesmo padrão de
-- `tarifa_manual` (v84) — pedido explícito do usuário ("o frete do vendedor
-- também pode ser alterado"), botão ✏️ ao lado de "Frete vend." no card
-- "Resumo por Venda" (bi-vendas.html). Maior precedência de TODAS as fontes
-- de frete_vendedor em calcularMargemLinha/CASE WHEN — vence Conciliação,
-- ml_payments, orders.shipping_seller_cost e até a substituição do custo
-- motoboy Flex (frete_motoboy, v85). NULL (padrão) = sem edição, segue a
-- precedência automática de sempre. Ver business-rules.md.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS frete_vendedor_manual NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS frete_vendedor_manual_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS frete_vendedor_manual_at TIMESTAMPTZ;

-- `vw_ml_orders` (schema.sql) é `SELECT * FROM orders ...` — sem recriar a
-- view na MESMA migration que adiciona a coluna, `o.frete_vendedor_manual`
-- quebraria com "column does not exist" até o PRÓXIMO `npm run migrate`
-- (gap real descoberto na v84, repetido na v85 — mesma correção aqui).
CREATE OR REPLACE VIEW vw_ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
