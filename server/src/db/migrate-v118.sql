-- Saldo INFORMADO das contas bancárias (v118) — página Dívidas do Dia, janela
-- de Pagar. O Fluxo de Caixa não sabe o saldo real das contas (a maioria das
-- entradas não tem conta), então quem paga digita o saldo do banco; o sistema
-- desconta sozinho cada saída lançada naquela conta DEPOIS desse horário
-- (cash_flow_entries.created_at, Supabase). Histórico: uma linha por informe.
-- conta_id = contas_bancarias.id do Supabase (uuid em texto). Ver
-- .claude/modules.md (Dívidas do Dia) e business-rules.md.
CREATE TABLE IF NOT EXISTS conta_saldos_informados (
  id SERIAL PRIMARY KEY,
  conta_id TEXT NOT NULL,
  valor NUMERIC(14,2) NOT NULL,
  informado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  informado_por TEXT
);
CREATE INDEX IF NOT EXISTS conta_saldos_informados_conta_idx ON conta_saldos_informados (conta_id, informado_em DESC);
