-- v133: categorias do Extrato Bancário (OFX) criadas pelo usuário (botão "➕ Nova
-- categoria"). Somam-se às fixas de ofxCategorias.js (mesmo POR_ID). id 'u_…'
-- nunca colide com as fixas. Ver .claude/extrato-ofx.md.
CREATE TABLE IF NOT EXISTS ofx_categorias_custom (
  id         TEXT PRIMARY KEY,
  nome       TEXT NOT NULL,
  ico        TEXT NOT NULL DEFAULT '🏷️',
  sentido    TEXT NOT NULL CHECK (sentido IN ('entrada', 'saida')),
  criado_por TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
