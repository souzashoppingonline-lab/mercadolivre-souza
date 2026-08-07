-- v67 — Cura o drift de schema em analise_product_ads (produção estava sem
-- colunas que o upsertAd grava, ex.: "descricao", o que fazia a coleta da
-- extensão dar 500 "column descricao does not exist"). Reaplica TODAS as
-- colunas com IF NOT EXISTS (idempotente — não quebra onde já existem). Alinha
-- o banco com o CREATE TABLE de schema.sql. Ver .claude/analise-produtos.md e
-- known-bugs (migrations não aplicadas).
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS link            TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS titulo          TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco           NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_original  NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS nota            NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas          TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS perguntas       INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS comentarios     INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendedor        TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS cidade          TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS estado          TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS reputacao       TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS is_full         BOOLEAN;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS is_flex         BOOLEAN;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS fotos           JSONB;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS videos          JSONB;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS raw             JSONB;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS observacoes     TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS comentarios_texto TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS comentarios_auto  TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS descricao       TEXT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS highlights      JSONB;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS monitorar       BOOLEAN DEFAULT true;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_7d       INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_7d  NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_15d      INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_15d NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_21d      INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_21d NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_30d      INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_30d NUMERIC;
