-- v61: descrição do anúncio concorrente na Análise de Produtos.
-- A extensão v2 passou a capturar a descrição da página (rawData.extracted.description);
-- guardamos no card pra a IA/decisão e pra leitura rápida. Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS descricao TEXT;
