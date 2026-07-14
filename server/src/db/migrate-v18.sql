-- v18 — Shopee sai do stub: habilita o marketplace (seed feito desde a v15,
-- mas enabled=false até haver credenciais reais), adiciona a coluna que
-- identifica a loja Shopee (shop_id — numérico real da Shopee, diferente da
-- Amazon que não tinha um ID curto natural e por isso usa faixa sintética
-- 9000000001+) e a tabela de campos exclusivos de pedido Shopee, mesmo
-- padrão de amazon_order_data (ver .claude/decisions.md).
--
-- Tokens (access_token/refresh_token/token_expires_at) reaproveitam as
-- colunas genéricas de `stores` já usadas pelo ML/Amazon — não precisa de
-- tabela de token própria (ver .claude/shopee.md).
-- api_type vira 'polling' na fase 1 mesmo a Shopee suportando webhook
-- ("Mecanismo de Empurra") — migrar para push fica para uma fase 2 (ver .claude/shopee.md).
UPDATE marketplaces SET enabled = true, api_type = 'polling' WHERE code = 'SHOPEE';

ALTER TABLE stores ADD COLUMN IF NOT EXISTS shopee_shop_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_shopee_shop_id ON stores(shopee_shop_id) WHERE shopee_shop_id IS NOT NULL;

-- Campos exclusivos de pedidos Shopee — orders continua só com campos comuns.
CREATE TABLE IF NOT EXISTS shopee_order_data (
  order_id TEXT PRIMARY KEY REFERENCES orders(ml_id),
  order_sn TEXT NOT NULL,
  shop_id BIGINT,
  buyer_username TEXT,
  order_status TEXT,
  raw_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_order_data_order_sn ON shopee_order_data(order_sn);
