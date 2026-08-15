-- v78: Sistema de níveis e rastreamento de devoluções para anúncios em RANQUEADO
-- Nível = 1 + (sales_count / 10), mostrando progressão do anúncio ranqueado
-- ranking_return_issues rastreia devoluções/reclamações associadas ao anúncio

ALTER TABLE ranking_ads ADD COLUMN nivel INT DEFAULT 1;
-- Nível é calculado no backend: 1 + FLOOR(sales_count / 10)

-- Tabela de devoluções/reclamações do anúncio (cache para não varrer returns toda vez)
CREATE TABLE IF NOT EXISTS ranking_return_issues (
  id SERIAL PK,
  ranking_ad_id INT NOT NULL FK ranking_ads ON DELETE CASCADE,
  return_id BIGINT,  -- reference to returns.id (se houver)
  item_id TEXT,
  buyer_nickname TEXT,
  reason TEXT,
  status TEXT,
  amount NUMERIC,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ranking_return_issues_ad
  ON ranking_return_issues(ranking_ad_id);
