-- v14: tabela para guardar scores de qualidade dos anúncios (API /item/{id}/performance)
CREATE TABLE IF NOT EXISTS item_performance (
  id          SERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL,
  item_id     TEXT NOT NULL,
  score       NUMERIC(5,2),
  level       TEXT,
  level_wording TEXT,
  pending_count INT DEFAULT 0,
  buckets     JSONB DEFAULT '[]',
  calculated_at TIMESTAMPTZ,
  synced_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(item_id)
);
CREATE INDEX IF NOT EXISTS item_performance_store ON item_performance(store_id);
CREATE INDEX IF NOT EXISTS item_performance_score ON item_performance(score);
