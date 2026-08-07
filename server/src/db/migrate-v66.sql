-- v66 — Monitoramento automático de concorrentes pela extensão (background).
-- A "watchlist" já é a própria analise_product_ads (concorrentes coletados por
-- produto). Só falta saber quando cada um foi recoletado, pra a extensão pedir
-- os mais desatualizados (1×/dia) via GET /extension/monitoramento/proximos.
-- Ver .claude/analise-produtos.md.
ALTER TABLE analise_product_ads ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

-- Fila da extensão: pega os que têm monitorar=true e last_checked_at mais antigo
-- (NULL primeiro). Índice cobre exatamente esse ORDER BY / WHERE.
CREATE INDEX IF NOT EXISTS idx_analise_ads_monitor_check
  ON analise_product_ads (monitorar, last_checked_at NULLS FIRST)
  WHERE ml_id IS NOT NULL;
