-- v26 — Monitor de Buy-Box / Concorrência de Catálogo. Escopo: itens com
-- catalog_listing=true (subconjunto dos itens já cobertos por item_seo_score,
-- v25). Ver .claude/decisions.md (pivot de "ranking por palavra-chave" —
-- bloqueado pela API do ML, GET /sites/MLB/search devolve 403 — pra este
-- módulo, que usa price_to_win/products/:id/items, endpoints diferentes e
-- confirmados ao vivo como acessíveis).

CREATE TABLE IF NOT EXISTS catalog_competition (
  id SERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT UNIQUE REFERENCES items(ml_id),
  catalog_product_id TEXT,
  status TEXT,               -- valor cru de price_to_win.status (ex: "competing"); "ganhando" é
                              -- decidido comparando winner_item_id = item_id, não por esta string
                              -- (só um valor foi confirmado ao vivo, ver decisions.md)
  current_price NUMERIC,
  price_to_win NUMERIC,
  winner_item_id TEXT,
  winner_price NUMERIC,
  boosts_missing TEXT[],     -- ids dos boosts com status='opportunity' (ex: fulfillment, free_shipping)
  consistent BOOLEAN,
  visit_share TEXT,
  calculated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_catalog_competition_store ON catalog_competition(store_id);
CREATE INDEX IF NOT EXISTS idx_catalog_competition_status ON catalog_competition(status);

CREATE TABLE IF NOT EXISTS catalog_competition_history (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT,
  store_id BIGINT,
  status TEXT,
  current_price NUMERIC,
  price_to_win NUMERIC,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalog_competition_history_item ON catalog_competition_history(item_id, captured_at DESC);
