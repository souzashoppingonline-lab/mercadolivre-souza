-- v64: fecha 2 gaps de schema que quebravam um banco criado do zero
-- (known-bugs #1 e #4). Ambos idempotentes.

-- #1 — questions.tg_message_id: worker grava o message_id do Telegram pra
-- casar respostas via reply (webhookGateway POST /webhooks/telegram). A coluna
-- nunca existiu em migration/schema, então "responder via reply" falhava calado.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS tg_message_id BIGINT;

-- #4 — messages_pack_id_unique: handleMessage faz INSERT ... ON CONFLICT
-- (pack_id), que EXIGE um índice único em pack_id. O migrate-v10 que o criava
-- ficou de fora da lista de db/migrate.js, então um banco novo não tinha o
-- índice e TODO webhook de mensagem falhava ("no unique constraint matching").
-- Dedupe defensivo antes de criar o índice (mantém a linha mais recente por
-- pack_id) — cobre um banco que tenha rodado sem o índice e acumulado dups.
DELETE FROM messages a USING messages b
  WHERE a.pack_id = b.pack_id AND a.pack_id IS NOT NULL AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS messages_pack_id_unique ON messages(pack_id);
