-- v46: Shopee multi-partner_id support — credenciais por loja (not-for-production-yet)
-- Permite que cada loja Shopee tenha seu próprio partner_id/partner_key, em vez de
-- usar apenas o global SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY. Se NULL, cai pra global.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS shopee_partner_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shopee_partner_key TEXT;

CREATE INDEX IF NOT EXISTS idx_stores_shopee_partner ON stores(shopee_partner_id) WHERE shopee_partner_id IS NOT NULL;
