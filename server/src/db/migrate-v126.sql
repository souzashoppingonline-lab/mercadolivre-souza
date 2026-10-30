-- v126: foto do anúncio vendido na Tela Telegram (TV). Só na tela — a mensagem
-- do Telegram continua só texto (pedido do usuário). Gravada no "🛒 Nova venda!"
-- (ML: items.thumbnail em tamanho maior; Shopee: imagem do item do pedido).
ALTER TABLE telegram_mensagens ADD COLUMN IF NOT EXISTS imagem TEXT;
