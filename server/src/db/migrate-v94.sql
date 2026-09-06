-- v94 — TikTok Shop sai do stub (Fase 1: só vendas, pedido explícito do
-- usuário). Habilita o marketplace (seed feito desde a v15 no catálogo
-- `marketplaces`, mas enabled=false até haver credenciais reais), adiciona
-- as colunas que identificam a loja TikTok Shop e a tabela de campos
-- exclusivos de pedido, mesmo padrão de amazon_order_data/shopee_order_data
-- (ver .claude/decisions.md "Marketplace Engine").
--
-- Tokens (access_token/refresh_token/token_expires_at) reaproveitam as
-- colunas genéricas de `stores` já usadas pelo ML/Amazon/Shopee — não
-- precisa de tabela de token própria (ver .claude/tiktok.md).
UPDATE marketplaces SET enabled = true, api_type = 'polling' WHERE code = 'TIKTOK';

-- shop_id = identificador numérico da loja; shop_cipher = identificador
-- criptografado exigido por boa parte da Shop API além do shop_id (formato
-- de autorização multi-loja da TikTok Shop). Guardados juntos por conta.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tiktok_shop_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tiktok_shop_cipher TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_tiktok_shop_id ON stores(tiktok_shop_id) WHERE tiktok_shop_id IS NOT NULL;

-- Campos exclusivos de pedidos TikTok Shop — orders continua só com campos
-- comuns (mesmo padrão de amazon_order_data/shopee_order_data).
CREATE TABLE IF NOT EXISTS tiktok_order_data (
  order_id TEXT PRIMARY KEY REFERENCES orders(ml_id),
  shop_id TEXT,
  order_status TEXT,
  raw_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
