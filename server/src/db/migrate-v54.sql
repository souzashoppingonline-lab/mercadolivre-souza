-- v54 — Análise de Produtos: resultado do motor de IA (Fase 3, núcleo).
-- Guarda a última análise da IA no próprio produto: JSON com as seções dos
-- agentes (comentários, financeiro, decisão) + Score do Produto (0-100).
-- Um produto = uma análise vigente (reanalisar sobrescreve). Ver .claude/analise-produtos.md.
ALTER TABLE analise_products ADD COLUMN IF NOT EXISTS ai_result JSONB;
ALTER TABLE analise_products ADD COLUMN IF NOT EXISTS ai_score INT;
ALTER TABLE analise_products ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ;
