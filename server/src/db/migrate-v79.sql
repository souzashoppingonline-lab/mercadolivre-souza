-- v79: alertas agendados para revisão de ADS do anúncio em rankeamento
CREATE TABLE IF NOT EXISTS ranking_ads_alerts (
  id SERIAL PRIMARY KEY,
  ranking_ad_id INT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  message TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT fk_ranking_alerts FOREIGN KEY (ranking_ad_id) REFERENCES ranking_ads(id) ON DELETE CASCADE,
  CONSTRAINT uq_ranking_ad_scheduled UNIQUE (ranking_ad_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_ranking_alerts_scheduled ON ranking_ads_alerts(scheduled_at, notified_at)
  WHERE notified_at IS NULL;
