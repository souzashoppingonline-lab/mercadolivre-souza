-- v57 — Análise de Produtos: VENDAS REAIS por janela (do "Shopping de Preço").
-- Preenchidas à mão (a extensão não pega isso): unidades vendidas e preço médio
-- praticado em 7/15/21/30 dias. É o dado mais relevante pra decisão de compra —
-- a IA dá peso alto quando presente. Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_7d INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_7d NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_15d INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_15d NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_21d INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_21d NUMERIC;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS vendas_30d INT;
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS preco_medio_30d NUMERIC;
