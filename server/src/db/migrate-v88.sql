-- v88 — 5º estágio do Rankeamento: 'catalogo' (Monitor de Buy-Box dedicado).
-- Mesmo padrão de monitoramento_started_at (v77) / recuperacao_started_at
-- (v80): carimba quando o anúncio entrou nesse estágio, pra contar "Xd em
-- catálogo" no card. Nenhuma alteração em catalog_competition/
-- catalog_competition_history (v26) — o estágio novo só CONSOME essas
-- tabelas que já existiam, nunca duplica o schema de Buy-Box.
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS catalogo_started_at TIMESTAMPTZ;
