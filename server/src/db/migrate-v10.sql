-- v10: unique index em messages.pack_id para evitar duplicatas
CREATE UNIQUE INDEX IF NOT EXISTS messages_pack_id_unique ON messages(pack_id);
