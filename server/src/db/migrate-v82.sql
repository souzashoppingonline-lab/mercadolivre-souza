-- v82: Reconciliação automática de frete/tarifa (financeReconciliationJob).
--
-- `orders.ml_fee`/`shipping_seller_cost` já nascem com DEFAULT 0 (nunca NULL)
-- desde sempre — não dá pra usar essas colunas pra saber se um pedido ainda
-- precisa de sincronização com o Mercado Livre ("pendente" != "confirmado
-- como zero pela API"). `finance_synced` é o marcador dedicado: só vira TRUE
-- depois que financeService.reconciliarPedido confirma tarifa E frete do
-- vendedor por uma chamada real (mesmo que o valor confirmado seja 0).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS finance_synced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS finance_sync_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_finance_sync_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_finance_sync_error TEXT;

-- Índice parcial — o job só faz SELECT sobre finance_synced=false (a maioria
-- dos pedidos, uma vez reconciliados, sai do universo de busca pra sempre).
CREATE INDEX IF NOT EXISTS idx_orders_finance_pending
  ON orders (last_finance_sync_at NULLS FIRST, date_created)
  WHERE finance_synced = false AND status <> 'cancelled';
