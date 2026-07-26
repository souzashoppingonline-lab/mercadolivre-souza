-- v52 — Análise de Produtos: campo de comentários COLADOS no anúncio concorrente.
-- Diferente de `comentarios` (contagem numérica) e de `observacoes` (anotação livre):
-- aqui o operador cola o texto cru dos comentários do concorrente (Ctrl C / Ctrl V,
-- sem separação), pra a Fase 3 (IA) agrupar reclamações/elogios depois.
-- Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS comentarios_texto TEXT;
