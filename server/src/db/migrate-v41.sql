-- v41 — promoções Shopee (descontos + vouchers) com prazos, pra acompanhar na
-- tela e alertar vencimento no Telegram. Preenchida pelo job syncShopeePromos
-- (marketplaceEventWorker). PK composta (tipo, promo_id) porque discount_id e
-- voucher_id vivem em espaços separados. expiry_notified = dedup do alerta.
CREATE TABLE IF NOT EXISTS shopee_promotions (
  tipo TEXT NOT NULL,              -- 'discount' | 'voucher'
  promo_id TEXT NOT NULL,          -- discount_id ou voucher_id
  store_id BIGINT,
  name TEXT,
  code TEXT,                       -- voucher_code (null p/ desconto)
  start_time BIGINT,               -- epoch s
  end_time BIGINT,                 -- epoch s (o "prazo")
  desconto TEXT,                   -- resumo legível: "12%" / "R$5" / etc
  status TEXT,                     -- upcoming | ongoing | expired (calculado)
  raw JSONB,
  expiry_notified BOOLEAN DEFAULT false,  -- já alertou vencimento no Telegram?
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tipo, promo_id)
);
CREATE INDEX IF NOT EXISTS idx_shopee_promotions_store ON shopee_promotions(store_id);
CREATE INDEX IF NOT EXISTS idx_shopee_promotions_end ON shopee_promotions(end_time);
