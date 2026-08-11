-- v76 — Rankeamento: 3º estágio "monitoramento" + log de alterações por card.
-- Monitoramento = produto que já ranqueou, caiu as vendas, foram feitas
-- alterações e agora acompanha-se o efeito. O card tem um log de anotações
-- (o que foi alterado). A fase 'monitoramento' entra em ranking_ads.fase (que
-- já é TEXT, sem constraint) — nada a alterar na coluna. Ver .claude/rankeamento.md.

CREATE TABLE IF NOT EXISTS ranking_notes (
  id SERIAL PRIMARY KEY,
  ranking_ad_id INT REFERENCES ranking_ads(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,              -- anotação livre (ex.: "baixei preço, troquei foto de capa")
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_notes_ad ON ranking_notes(ranking_ad_id, created_at DESC);
