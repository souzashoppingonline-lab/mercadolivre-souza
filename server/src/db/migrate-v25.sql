-- v25 — Qualidade de Anúncio: SEO Score próprio (fórmula determinística,
-- nunca IA), auditoria de atributos faltando e histórico pra gráfico de
-- evolução. Ver .claude/decisions.md e .claude/business-rules.md.

CREATE TABLE IF NOT EXISTS item_seo_score (
  id SERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT UNIQUE REFERENCES items(ml_id),
  category_id TEXT,
  brand TEXT,
  -- sinais brutos (dado oficial da API, usados também pra auditoria "sem X")
  pictures_count INT,
  has_video BOOLEAN,
  title_length INT,
  description_word_count INT,
  has_gtin BOOLEAN,
  has_brand BOOLEAN,
  has_model BOOLEAN,
  is_full BOOLEAN,
  shipping_type TEXT, -- shipping.logistic_type cru (fulfillment/self_service/xd_drop_off/...) — mesma
                       -- classificação de logLabel() já usada em orders.shipping_type, pro filtro
                       -- "Tipo Logístico" (diferente do toggle simples "FULL")
  catalog_listing BOOLEAN,
  required_attrs_total INT,
  required_attrs_missing INT,
  missing_required_attrs TEXT[],
  visits_30d INT,
  sales_30d INT,
  conversion_rate NUMERIC,
  -- subscores (métrica calculada pelo sistema — nunca sobrescreve o dado oficial acima)
  photos_score NUMERIC(5,2),
  video_score NUMERIC(5,2),
  title_score NUMERIC(5,2),
  description_score NUMERIC(5,2),
  gtin_score NUMERIC(5,2),
  brand_score NUMERIC(5,2),
  model_score NUMERIC(5,2),
  full_score NUMERIC(5,2),
  catalog_score NUMERIC(5,2),
  attributes_score NUMERIC(5,2),
  conversion_score NUMERIC(5,2),
  visits_score NUMERIC(5,2),
  score NUMERIC(5,2),
  calculated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_item_seo_score_store ON item_seo_score(store_id);
CREATE INDEX IF NOT EXISTS idx_item_seo_score_score ON item_seo_score(score);
CREATE INDEX IF NOT EXISTS idx_item_seo_score_category ON item_seo_score(category_id);

CREATE TABLE IF NOT EXISTS item_seo_score_history (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT,
  store_id BIGINT,
  score NUMERIC(5,2),
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_item_seo_history_item ON item_seo_score_history(item_id, captured_at DESC);

-- Atributos obrigatórios por categoria mudam raramente — cacheado pra não
-- rechamar GET /categories/:id/attributes pra cada item da mesma categoria
-- todo dia (uma loja com 500 itens em 30 categorias faz 30 chamadas, não 500).
CREATE TABLE IF NOT EXISTS category_attributes_cache (
  category_id TEXT PRIMARY KEY,
  required_ids TEXT[],
  updated_at TIMESTAMPTZ DEFAULT now()
);
