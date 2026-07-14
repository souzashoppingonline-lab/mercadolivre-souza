-- v20 — Agenda Trello: regra de dedup do TaskEngine mudou (ver decisions.md).
-- Antes só bloqueava duplicata enquanto o cartão estava aberto (fora de
-- finalizado/excluído); agora bloqueia em qualquer status, só permitindo
-- recriar depois que o cartão anterior for movido pra Excluído. O índice
-- parcial precisa refletir o novo predicado da query (WHERE board_column !=
-- 'excluido'), senão o Postgres não usa o índice pra essa consulta.
DROP INDEX IF EXISTS idx_tasks_rule_item_open;
CREATE INDEX IF NOT EXISTS idx_tasks_rule_item_open ON tasks(rule_key, item_id) WHERE board_column != 'excluido';
