-- v43 — flag "Abrir chamado" por devolução (returns), marcada manualmente na
-- página de Devoluções (checkbox). Sai como Sim/Não no CSV/PDF. Idempotente.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS abertura_chamado BOOLEAN DEFAULT false;
