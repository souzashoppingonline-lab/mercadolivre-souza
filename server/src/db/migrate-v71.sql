-- v71 — Rankeamento em 2 fases. Depois que o anúncio "pega tração" ele passa
-- de 'rankeando' (empurrar: notifica cada venda) para 'ranqueado' (defender:
-- silencia venda, só alerta regressão). Transição MANUAL (com sugestão
-- automática na tela). Ver .claude/rankeamento.md.
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS fase TEXT DEFAULT 'rankeando';   -- 'rankeando' | 'ranqueado'
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS ranqueado_em TIMESTAMPTZ;         -- quando passou pra fase 2
CREATE INDEX IF NOT EXISTS idx_ranking_ads_fase ON ranking_ads(fase);
