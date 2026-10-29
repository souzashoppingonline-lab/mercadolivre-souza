-- v121: Rankeamento — TODA mudança vai pro Telegram (pedido do usuário).
-- Aviso de alteração que cai na janela de silêncio (22–07h) não é mais
-- perdido: o evento fica marcado como pendente e o job flushRankingPendentes
-- (worker.js, a cada 10 min) manda quando o silêncio acaba.
ALTER TABLE ranking_events ADD COLUMN IF NOT EXISTS tg_pendente BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ranking_events_tg_pendente_idx ON ranking_events (created_at) WHERE tg_pendente;
