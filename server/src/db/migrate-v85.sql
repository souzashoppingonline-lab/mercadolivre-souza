-- v85: reembolso do Mercado Livre ao VENDEDOR por envio (`senders[].save` +
-- `senders[].compensation` de GET /shipments/:id/costs — ver
-- server/src/shipmentCosts.js). Distinto de `receiver.save`/discounts, que é
-- o subsídio de frete grátis PRO COMPRADOR (nunca confundir — ver
-- business-rules.md "Frete Flex — subsídio ao comprador, não ao vendedor").
-- Usado como o termo a subtrair do valor fixo de motoboy nas vendas Flex
-- (feature "frete_motoboy", app_config), pra não descontar 2x se o ML algum
-- dia passar a reembolsar o vendedor de verdade (0 em toda amostra real
-- testada até agora).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_seller_reembolso NUMERIC DEFAULT 0;

-- `vw_ml_orders` (schema.sql) é `SELECT * FROM orders ...` — sem recriar a
-- view na MESMA migration que adiciona a coluna, `o.shipping_seller_reembolso`
-- quebraria com "column does not exist" até o PRÓXIMO `npm run migrate`
-- (gap real descoberto na v84, ver known-bugs.md — mesma correção repetida
-- aqui).
CREATE OR REPLACE VIEW vw_ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
