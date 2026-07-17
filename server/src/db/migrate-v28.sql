-- v28 — Prejuízo manual por devolução (valor em R$ digitado pelo usuário,
-- não vem da API do ML). Ver .claude/business-rules.md e decisions.md.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS prejuizo NUMERIC;
