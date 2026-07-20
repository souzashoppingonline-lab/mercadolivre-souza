-- v38 — resposta ao cliente no chat Shopee dentro da plataforma. Pra enviar
-- (sellerchat/send_message) precisamos do user_id do comprador (to_id), que
-- vem no get_conversation_list mas não era guardado. Idempotente (ADD COLUMN
-- IF NOT EXISTS) — ver known-bugs item 4.
ALTER TABLE shopee_chat ADD COLUMN IF NOT EXISTS to_id TEXT;  -- user_id do comprador (destinatário do send_message)
