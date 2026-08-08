-- v70 — Rankeamento: posição do anúncio nos "Mais Vendidos" (highlights) da
-- categoria. Preenchida pelo snapshot (job sync-ranking) via
-- getCategoryHighlights; NULL = fora do ranking de destaque.
-- Ver .claude/rankeamento.md.
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS last_highlight_pos INT;
