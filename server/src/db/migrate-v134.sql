-- v134: código do anúncio (MLB) na mensagem da Tela Telegram — a foto da
-- "Nova venda!" vira link pra aba Raio-X do anúncio (pages/anuncio-raio-x.html).
-- Só mensagens novas de venda ML preenchem; o resto fica NULL (foto sem clique).
ALTER TABLE telegram_mensagens ADD COLUMN IF NOT EXISTS item_id TEXT;
