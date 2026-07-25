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

-- Se a coluna já existia como NUMERIC (versão anterior desta migration, antes de
-- descobrirmos que o campo é um objeto), o ADD COLUMN IF NOT EXISTS acima é pulado
-- e o tipo continua errado. Corrige o tipo ANTES do UPDATE abaixo — senão o UPDATE
-- tenta gravar JSONB em coluna numeric e falha. USING NULL é seguro: o valor real é
-- re-derivado de escrow_raw logo em seguida.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shopee_order_data'
      AND column_name = 'seller_product_rebate'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE shopee_order_data ALTER COLUMN seller_product_rebate TYPE JSONB USING NULL;
  END IF;
END $$;

-- Backfill a partir do JSON cru já persistido em escrow_raw (JSONB) — sem
-- re-chamar a API Shopee. Pedidos sincronizados antes da mudança simplesmente
-- não têm os campos NET no JSON (ficam NULL e o cálculo cai no bruto).
UPDATE shopee_order_data SET
  service_fee           = NULLIF(escrow_raw->'order_income'->>'service_fee','')::numeric,
  net_commission_fee    = NULLIF(escrow_raw->'order_income'->>'net_commission_fee','')::numeric,
  net_service_fee       = NULLIF(escrow_raw->'order_income'->>'net_service_fee','')::numeric,
  seller_product_rebate = escrow_raw->'order_income'->'seller_product_rebate'
WHERE escrow_raw IS NOT NULL;
