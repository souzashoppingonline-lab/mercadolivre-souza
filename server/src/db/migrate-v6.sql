-- Migration v6 — promotions tracking table.
-- NUNCA aplicada por migrate.js (faltava na lista de arquivos — ver
-- known-bugs.md) — nesse meio tempo `schema.sql` passou a criar a MESMA
-- tabela `promotions` (com um índice correto, `changed_at DESC`, sem o cast
-- pra date que este arquivo tem abaixo — cast que nem compila: Postgres
-- recusa `changed_at::date` num índice porque a conversão timestamptz→date
-- depende do fuso da sessão, não é IMMUTABLE). Portanto este arquivo está
-- SUPERSEDIDO por schema.sql e não deve ser adicionado à lista de
-- migrate.js — mantido só por histórico, com a sintaxe corrigida.
CREATE TABLE IF NOT EXISTS promotions (
  id              SERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  offer_id        TEXT NOT NULL,
  item_id         TEXT,
  item_title      TEXT,
  status          TEXT,
  previous_status TEXT,
  original_price  NUMERIC DEFAULT 0,
  promo_price     NUMERIC DEFAULT 0,
  discount_pct    NUMERIC DEFAULT 0,
  changed_at      TIMESTAMPTZ DEFAULT now(),
  raw_data        JSONB
);
CREATE INDEX IF NOT EXISTS promotions_store_day ON promotions(store_id, (changed_at::date));
