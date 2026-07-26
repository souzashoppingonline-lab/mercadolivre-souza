-- v51 — Análise de Produtos: campo de observações no anúncio concorrente.
-- Permite anotar à mão o que a extensão não capturou (ex.: principais reclamações
-- dos comentários). Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS observacoes TEXT;
