-- v123: IA Estrategista na rotina (Telegram 08:05, críticos, cobrança de
-- ação parada, resultado automático 14 dias depois). Ver .claude/workers.md.
-- status_desde: quando a ação entrou no status atual (cobrança de parada
-- usa isto, não updated_at — editar a observação não "zera" a cobrança).
ALTER TABLE ia_estrategista_acoes ADD COLUMN IF NOT EXISTS status_desde TIMESTAMPTZ NOT NULL DEFAULT now();
-- resultado_auto_em: quando o sistema lançou sozinho o antes×depois (1 vez por conclusão).
ALTER TABLE ia_estrategista_acoes ADD COLUMN IF NOT EXISTS resultado_auto_em TIMESTAMPTZ;
-- Última prioridade conhecida de cada anúncio — detecta "entrou em Crítico (80+)".
CREATE TABLE IF NOT EXISTS ia_estrategista_estado (
  ranking_ad_id INT PRIMARY KEY,
  prioridade INT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
