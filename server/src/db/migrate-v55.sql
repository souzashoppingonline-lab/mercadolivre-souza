-- v55 — Análise de Produtos: criativos gerados pela IA (7 briefs de imagem em JSON,
-- cada um quebrando uma objeção dos comentários). O usuário cola cada JSON no
-- ChatGPT pra gerar a foto. Guardado no produto pra não regerar toda vez.
-- Ver .claude/analise-produtos.md.
ALTER TABLE analise_products ADD COLUMN IF NOT EXISTS ai_creativos JSONB;
ALTER TABLE analise_products ADD COLUMN IF NOT EXISTS ai_creativos_at TIMESTAMPTZ;
