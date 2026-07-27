-- v53 — Análise de Produtos: separar comentários AUTOMÁTICOS (extensão) dos MANUAIS.
-- `comentarios_auto` recebe o que o extrator recorta da seção "Opiniões" da página
-- (só os visíveis) e é atualizado a cada recoleta. `comentarios_texto` (v51) fica
-- exclusivo pro operador colar/escrever à mão — a extensão nunca sobrescreve.
-- Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS comentarios_auto TEXT;
