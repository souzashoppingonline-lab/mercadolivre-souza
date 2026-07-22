-- v44: taxas LÍQUIDAS (NET) do escrow Shopee.
-- A Shopee (comunicados dez/2025–fev/2026) passou a expor as taxas também em
-- valor líquido (após rebates/abatimentos) em v2.payment.get_escrow_detail.
-- As taxas brutas (commission_fee) continuam, mas os NET são o valor final
-- efetivamente descontado do vendedor. Ver .claude/shopee.md.
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS service_fee           NUMERIC;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS net_commission_fee    NUMERIC;
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS net_service_fee       NUMERIC;
-- seller_product_rebate é um OBJETO ({amount, commission_fee_offset,
-- service_fee_offset}), não um escalar — guardamos como JSONB.
ALTER TABLE shopee_order_data ADD COLUMN IF NOT EXISTS seller_product_rebate JSONB;

-- Backfill a partir do JSON cru já persistido em escrow_raw (JSONB) — sem
-- re-chamar a API Shopee. Pedidos sincronizados antes da mudança simplesmente
-- não têm os campos NET no JSON (ficam NULL e o cálculo cai no bruto).
UPDATE shopee_order_data SET
  service_fee           = NULLIF(escrow_raw->'order_income'->>'service_fee','')::numeric,
  net_commission_fee    = NULLIF(escrow_raw->'order_income'->>'net_commission_fee','')::numeric,
  net_service_fee       = NULLIF(escrow_raw->'order_income'->>'net_service_fee','')::numeric,
  seller_product_rebate = escrow_raw->'order_income'->'seller_product_rebate'
WHERE escrow_raw IS NOT NULL;
