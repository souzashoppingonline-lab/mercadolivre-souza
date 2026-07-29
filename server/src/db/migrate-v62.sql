-- v62: highlights ("O que você precisa saber sobre este produto") do anúncio
-- concorrente. A extensão v2 captura os bullets de destaque da página; guardamos
-- pra a decisão/IA e leitura no card. Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS highlights JSONB;
