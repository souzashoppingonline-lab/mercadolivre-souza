-- v131: zera UMA vez o contador antigo de chat ML (messages.unread), que só somava —
-- inclusive as respostas da própria loja — e chegou a ~1.200 conversas "sem resposta"
-- já respondidas. Daqui pra frente vale o que a API do ML devolve em /messages/unread
-- (worker syncChatsMlPendentes, 10 min + boot). Marca em app_config pra não repetir
-- (as migrations rodam a cada deploy). Ver .claude/decisions.md (v150/v151).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE key = 'ml_unread_reset_v131') THEN
    UPDATE messages SET unread = 0 WHERE COALESCE(unread, 0) > 0;
    INSERT INTO app_config (key, value) VALUES ('ml_unread_reset_v131', 'aplicada') ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;
