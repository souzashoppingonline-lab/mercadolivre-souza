-- Suporte a múltiplas contas por marketplace (Amazon hoje; mesmo padrão
-- serve para Shopee quando for implementada). `stores` já é genérica o
-- suficiente para guardar várias contas Amazon (uma linha por conta,
-- reaproveitando `refresh_token` do mesmo jeito que o ML já usa) — só
-- faltavam colunas de override por conta para marketplace/região, já que
-- contas Amazon diferentes podem vender em países diferentes.
-- Mesmo padrão de `ml_client_id`/`ml_client_secret`: override opcional por
-- linha, com fallback pros valores globais de server/.env quando NULL.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_marketplace_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_region TEXT;
