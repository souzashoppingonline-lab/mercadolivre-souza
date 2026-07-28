-- v60: Alertas de monitoramento de concorrentes (camada de AVISO sobre o snapshot).
--
-- CONTEXTO: a v58 já tira snapshot diário (preço/estoque/vendas/status) de cada
-- MLB monitorado em analise_monitor_snapshots, mas só GUARDA — não avisa. Esta
-- tabela registra as MUDANÇAS detectadas (preço subiu/caiu, estoque zerou/voltou,
-- anúncio pausou/encerrou, disparada de vendas) pra alimentar o Telegram e o
-- "Relatório de mudanças" dentro do card do concorrente.
--
-- Detecção e envio ficam em server/src/analise/monitor.js (recordSnapshot).
-- Ver .claude/analise-produtos.md e .claude/business-rules.md (limiares).

CREATE TABLE IF NOT EXISTS analise_monitor_alerts (
  id BIGSERIAL PRIMARY KEY,
  ml_id TEXT NOT NULL,
  product_id BIGINT,                 -- resolvido do anúncio no momento do alerta (pode ser null)
  alert_type TEXT NOT NULL,          -- price_up | price_down | stock_out | stock_back | paused | closed | sales_spike
  old_value TEXT,
  new_value TEXT,
  delta_pct NUMERIC,                 -- variação % (só preço)
  message TEXT,                      -- texto legível já pronto (o mesmo do Telegram, sem HTML)
  notified BOOLEAN DEFAULT false,    -- foi enviado ao Telegram?
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitor_alerts_mlid ON analise_monitor_alerts (ml_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_product ON analise_monitor_alerts (product_id, created_at DESC);
