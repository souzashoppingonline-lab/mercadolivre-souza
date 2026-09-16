-- v102 — Índices pra suportar os alertas de devolução do bipe (v100), que
-- passaram a filtrar orders/returns/shopee_returns por colunas sem índice
-- nenhum: em loja com histórico grande, cada bipe virou uma varredura
-- completa dessas tabelas. Usuário reportou lentidão real após o deploy do
-- v100 ("depois da última olhada tá demorando pra subir a venda") — causa
-- raiz confirmada olhando schema.sql (nenhum CREATE INDEX pra essas 4
-- colunas). Ver embalagem.md.
CREATE INDEX IF NOT EXISTS idx_orders_item_id ON orders(item_id);
CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_buyer_nickname ON returns(buyer_nickname);
CREATE INDEX IF NOT EXISTS idx_shopee_returns_item_id ON shopee_returns(item_id);
