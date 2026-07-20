-- v37 — chat Shopee (conversas com comprador), isolado. Guarda o estado de
-- cada conversa não lida pra listar na tela e deduplicar a notificação Telegram
-- (notified_message_id). Preenchido pelo job syncShopeeChat (marketplaceEventWorker).
CREATE TABLE IF NOT EXISTS shopee_chat (
  conversation_id TEXT PRIMARY KEY,
  store_id BIGINT,
  buyer_name TEXT,
  unread_count INT DEFAULT 0,
  last_message TEXT,
  last_message_type TEXT,
  last_message_time BIGINT,      -- timestamp em NANOSSEGUNDOS (formato da Shopee)
  latest_message_id TEXT,
  notified_message_id TEXT,      -- último latest_message_id já notificado (dedup Telegram)
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopee_chat_store ON shopee_chat(store_id);
CREATE INDEX IF NOT EXISTS idx_shopee_chat_unread ON shopee_chat(unread_count) WHERE unread_count > 0;
