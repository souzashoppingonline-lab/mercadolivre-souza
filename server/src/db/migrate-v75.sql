-- v75 — Rankeamento: vincular vários ml_id ao mesmo card (anúncio tradicional +
-- anúncio de catálogo do mesmo produto). Venda de qualquer ml_id vinculado conta
-- no card principal. Preço/estoque/snapshot continuam só do ml_id principal.
-- Ver .claude/rankeamento.md.

CREATE TABLE IF NOT EXISTS ranking_ad_links (
  id SERIAL PRIMARY KEY,
  ranking_ad_id INT REFERENCES ranking_ads(id) ON DELETE CASCADE,
  ml_id TEXT NOT NULL UNIQUE,     -- ml_id vinculado (ex.: anúncio de catálogo)
  tipo TEXT DEFAULT 'catalogo',   -- rótulo informativo: 'catalogo' | 'tradicional' | 'outro'
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_ad_links_ad ON ranking_ad_links(ranking_ad_id);
