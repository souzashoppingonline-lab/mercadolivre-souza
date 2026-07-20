-- v36 — financeiro (escrow) + status de entrega por pedido Shopee, isolado.
-- escrow_amount = líquido que o vendedor recebe (já descontadas taxas Shopee).
-- Preenchidos pelo worker quando o pedido tem pagamento confirmado (get_escrow_detail)
-- e envio arranjado (get_tracking_info). Ver .claude/shopee.md.
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS buyer_total NUMERIC;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS commission_fee NUMERIC;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS escrow_amount NUMERIC;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS buyer_payment_method TEXT;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS escrow_raw JSONB;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS logistics_status TEXT;
