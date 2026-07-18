-- PostgreSQL schema — single source of truth for the dashboard.
-- Populated exclusively by BullMQ workers reacting to ML webhooks.

-- Marketplace Engine — tabela discriminadora usada por marketplace_id em
-- stores/orders/items/messages (ver migrate-v15.sql e .claude/decisions.md).
CREATE TABLE IF NOT EXISTS marketplaces (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  api_type TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO marketplaces (code, name, api_type, enabled) VALUES
  ('ML',     'Mercado Livre', 'webhook', true),
  ('AMAZON', 'Amazon',        'polling', true),
  ('SHOPEE', 'Shopee',        'polling', true),
  ('MAGALU', 'Magalu',        'polling', false),
  ('TIKTOK', 'TikTok',        'polling', false)
ON CONFLICT (code) DO NOTHING;
-- Shopee saiu do stub na v18 (credenciais reais de sandbox obtidas) — em
-- bancos onde a linha já existia com enabled=false, o ON CONFLICT acima é
-- no-op, então o UPDATE explícito é necessário. api_type continua 'polling'
-- na fase 1 (mesmo padrão da Amazon) mesmo a Shopee suportando webhook
-- ("Mecanismo de Empurra") — migrar para webhook fica para uma fase 2,
-- depois de confirmar o contrato de push no console (ver .claude/shopee.md).
UPDATE marketplaces SET enabled = true, api_type = 'polling' WHERE code = 'SHOPEE';

CREATE TABLE IF NOT EXISTS item_changes (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  store_id BIGINT,
  changes JSONB NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_changes_item ON item_changes(item_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS item_changes_store ON item_changes(store_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS stores (
  id BIGINT PRIMARY KEY,
  nickname TEXT,
  level_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  active_listings INT DEFAULT 0,
  monthly_revenue NUMERIC DEFAULT 0,
  imposto_pct NUMERIC DEFAULT 0,
  ml_client_id TEXT,
  ml_client_secret TEXT,
  marketplace_id INT REFERENCES marketplaces(id),
  amazon_marketplace_id TEXT, -- override por conta Amazon; fallback AMAZON_MARKETPLACE_ID (.env) quando NULL
  amazon_region TEXT,         -- override por conta Amazon; fallback AMAZON_REGION (.env) quando NULL
  shopee_shop_id BIGINT,      -- shop_id real da Shopee (numérico, único por conta) — access_token/refresh_token/token_expires_at reaproveitam as colunas acima
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- Em bancos existentes, o CREATE TABLE acima é no-op — a coluna precisa
-- deste ALTER explícito para existir antes de qualquer INSERT/index que a use.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_marketplace_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS amazon_region TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shopee_shop_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_shopee_shop_id ON stores(shopee_shop_id) WHERE shopee_shop_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS items (
  ml_id TEXT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  title TEXT,
  price NUMERIC,
  available_quantity INT,
  sold_quantity INT,
  status TEXT,
  category_id TEXT,
  thumbnail TEXT,
  permalink TEXT,
  cost NUMERIC DEFAULT 0,
  marketplace_id INT REFERENCES marketplaces(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS thumbnail TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS permalink TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS parent_item_id TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

-- ml_id é TEXT (não BIGINT) para caber IDs de pedido não-numéricos de
-- outros marketplaces (ex: Amazon "902-1845936-3456781"). Ver migrate-v15.sql.
CREATE TABLE IF NOT EXISTS orders (
  ml_id TEXT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  buyer_nickname TEXT,
  item_id TEXT,
  title TEXT,
  quantity INT DEFAULT 1,
  unit_price NUMERIC DEFAULT 0,
  total_amount NUMERIC,
  ml_fee NUMERIC DEFAULT 0,
  shipping_type TEXT DEFAULT '',
  shipping_cost NUMERIC DEFAULT 0,
  shipping_seller_cost NUMERIC DEFAULT 0,
  status TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  date_created TIMESTAMPTZ,
  date_closed TIMESTAMPTZ,
  raw_data JSONB,
  marketplace_id INT REFERENCES marketplaces(id),
  shipping_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_shipping_id ON orders(shipping_id);

-- Status de Entrega (Conciliação Bancária) — ver migrate-v33.sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_substatus TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_ready_to_ship TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_shipped TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS date_delivered TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_last_updated TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_shipping_status ON orders(shipping_status);
CREATE INDEX IF NOT EXISTS idx_orders_shipping_id_status ON orders(shipping_id, shipping_status);

CREATE TABLE IF NOT EXISTS questions (
  ml_id BIGINT PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT,
  item_title TEXT,
  text TEXT,
  answer_text TEXT,
  status TEXT,
  date_created TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  pack_id TEXT,
  buyer_nickname TEXT,
  last_message TEXT,
  unread INT DEFAULT 0,
  last_message_date TIMESTAMPTZ,
  marketplace_id INT REFERENCES marketplaces(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

CREATE TABLE IF NOT EXISTS returns (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  order_id TEXT REFERENCES orders(ml_id),
  buyer_nickname TEXT,
  title TEXT,
  reason TEXT,
  amount NUMERIC,
  status TEXT,
  date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  note TEXT,
  raw_data JSONB,
  prejuizo NUMERIC -- v28: valor de prejuízo digitado manualmente pelo usuário (não vem da API do ML)
);

CREATE TABLE IF NOT EXISTS claim_reasons (
  id TEXT PRIMARY KEY,
  detail TEXT,
  flow TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Em bancos existentes, os CREATE TABLE acima são no-op (orders/returns já
-- existem) e não mudam o tipo de uma coluna já criada como BIGINT. A
-- conversão para TEXT precisa ser um ALTER explícito, feito ANTES de
-- qualquer tabela nova que faça FK para orders(ml_id) (ex: amazon_order_data
-- abaixo) — senão a FK falha por incompatibilidade de tipo. A constraint
-- precisa ser solta antes de alterar o tipo da coluna referenciada (Postgres
-- não permite alterar um lado sem o outro com a FK ativa) e recriada depois.
-- Guard "IF ... <> 'text'": a partir do momento em que este script já rodou
-- uma vez e criou a view vw_ml_orders (mais abaixo, v17) sobre orders.ml_id,
-- reexecuções seguintes deste ALTER (mesmo sendo um no-op TEXT→TEXT) quebram
-- com "cannot alter type of a column used by a view" — o Postgres recusa
-- ALTER COLUMN TYPE em coluna referenciada por view/rule mesmo quando o tipo
-- não muda de fato. O guard evita executar o ALTER quando não há nada a
-- converter, então nunca chega a tocar na coluna usada pela view.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'ml_id') <> 'text' THEN
    ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_order_id_fkey;
    ALTER TABLE orders  ALTER COLUMN ml_id    TYPE TEXT USING ml_id::TEXT;
    ALTER TABLE returns ALTER COLUMN order_id TYPE TEXT USING order_id::TEXT;
    ALTER TABLE returns ADD CONSTRAINT returns_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(ml_id);
  END IF;
END $$;

-- Campos exclusivos de pedidos Amazon — orders continua só com campos comuns.
CREATE TABLE IF NOT EXISTS amazon_order_data (
  order_id TEXT PRIMARY KEY REFERENCES orders(ml_id),
  amazon_order_id TEXT NOT NULL,
  seller_id TEXT,
  fulfillment_channel TEXT,
  order_type TEXT,
  raw_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_order_data_amazon_id ON amazon_order_data(amazon_order_id);

-- Campos exclusivos de pedidos Shopee — orders continua só com campos comuns.
CREATE TABLE IF NOT EXISTS shopee_order_data (
  order_id TEXT PRIMARY KEY REFERENCES orders(ml_id),
  order_sn TEXT NOT NULL,
  shop_id BIGINT,
  buyer_username TEXT,
  order_status TEXT,
  raw_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_order_data_order_sn ON shopee_order_data(order_sn);

-- Cursor de "última sincronização" para EventSources de polling (Amazon e Shopee).
CREATE TABLE IF NOT EXISTS marketplace_sync_state (
  marketplace_id INT NOT NULL REFERENCES marketplaces(id),
  source_key TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (marketplace_id, source_key)
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  resource TEXT NOT NULL,
  store_id BIGINT,
  status TEXT DEFAULT 'pending', -- pending | processed | failed
  error TEXT,
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schedule_jobs (
  name TEXT PRIMARY KEY,
  cron TEXT,
  last_run TIMESTAMPTZ,
  duration_ms INT,
  status TEXT DEFAULT 'idle' -- idle | running | success | error
);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  status TEXT, -- success | error | running
  report JSONB,
  error_msg TEXT
);
CREATE INDEX IF NOT EXISTS schedule_runs_job ON schedule_runs(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS store_metrics (
  id SERIAL PRIMARY KEY,
  store_id BIGINT NOT NULL,
  level_id TEXT,
  power_seller_status TEXT,
  transactions_completed INT DEFAULT 0,
  positive_ratings_pct NUMERIC DEFAULT 0,
  negative_ratings_pct NUMERIC DEFAULT 0,
  neutral_ratings_pct NUMERIC DEFAULT 0,
  collected_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  old_price NUMERIC,
  new_price NUMERIC,
  changed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date_created);
CREATE INDEX IF NOT EXISTS idx_items_store_status ON items(store_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_topic ON webhook_logs(topic);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_items_marketplace ON items(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_stores_marketplace ON stores(marketplace_id);

-- Store sentinela para a conta Amazon — só uma conta configurada via
-- server/.env hoje, sem descoberta dinâmica de lojas como o ML tem.
INSERT INTO stores (id, nickname, marketplace_id)
VALUES (9000000001, 'Amazon', (SELECT id FROM marketplaces WHERE code = 'AMAZON'))
ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS item_visits (
  id SERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  visits INT DEFAULT 0,
  date DATE NOT NULL,
  collected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_id, date)
);

CREATE INDEX IF NOT EXISTS store_metrics_store ON store_metrics(store_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS price_history_item ON price_history(item_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS item_visits_item ON item_visits(item_id, date DESC);
CREATE INDEX IF NOT EXISTS item_visits_store ON item_visits(store_id, date DESC);

CREATE TABLE IF NOT EXISTS ml_turbo_sales (
  id              SERIAL PRIMARY KEY,
  sale_id         TEXT        UNIQUE NOT NULL,
  cart_id         TEXT,
  buyer           TEXT,
  state           TEXT,
  item_code       TEXT,
  title           TEXT,
  account         TEXT,
  shipping_mode   TEXT,
  ads             NUMERIC     DEFAULT 0,
  sku             TEXT,
  sale_date       DATE,
  shipping_type   TEXT,
  unit_price      NUMERIC     DEFAULT 0,
  quantity        INT         DEFAULT 1,
  revenue         NUMERIC     DEFAULT 0,
  cost            NUMERIC     DEFAULT 0,
  tax             NUMERIC     DEFAULT 0,
  ml_fee          NUMERIC     DEFAULT 0,
  buyer_shipping  NUMERIC     DEFAULT 0,
  seller_shipping NUMERIC     DEFAULT 0,
  margin          NUMERIC     DEFAULT 0,
  margin_pct      NUMERIC     DEFAULT 0,
  order_status    TEXT,
  payment_status  TEXT,
  shipping_id     TEXT,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turbo_sale_date   ON ml_turbo_sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_turbo_account     ON ml_turbo_sales(account);
CREATE INDEX IF NOT EXISTS idx_turbo_sku         ON ml_turbo_sales(sku);
CREATE INDEX IF NOT EXISTS idx_turbo_item_code   ON ml_turbo_sales(item_code);
CREATE INDEX IF NOT EXISTS idx_turbo_state       ON ml_turbo_sales(state);
CREATE INDEX IF NOT EXISTS idx_turbo_order_status ON ml_turbo_sales(order_status);

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
CREATE INDEX IF NOT EXISTS promotions_store_day ON promotions(store_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS promotions_offer ON promotions(offer_id, changed_at DESC);

-- Views ML-only — telas existentes (construídas só para o ML) leem daqui em
-- vez de orders/items/stores diretamente, para não misturar outros
-- marketplaces (Amazon) nos KPIs/relatórios. Prefixo vw_ (não ml_) para não
-- colidir com as tabelas reais ml_orders/ml_items do sistema antigo
-- (ml-dashboard.service) que compartilha o mesmo Postgres. Ver migrate-v17.sql.
CREATE OR REPLACE VIEW vw_ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW vw_ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW vw_ml_stores AS
  SELECT * FROM stores
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

-- Agenda Trello (v19) — módulo de tarefas (Kanban), totalmente independente
-- do resto do schema. Ver .claude/task-engine.md.
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  board_column TEXT NOT NULL DEFAULT 'a_fazer', -- a_fazer | em_andamento | finalizado | excluido
  priority TEXT NOT NULL DEFAULT 'media',        -- alta | media | baixa
  marketplace_id INT REFERENCES marketplaces(id),
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT,                                  -- referência solta (não FK) a items.ml_id
  source TEXT NOT NULL DEFAULT 'sistema',        -- mercado_livre | amazon | shopee | sistema | manual
  rule_key TEXT,                                 -- chave da regra automática (dedup); NULL em manuais
  status TEXT NOT NULL DEFAULT 'aberto',         -- aberto | concluido
  tags TEXT[] DEFAULT '{}',
  assigned_to TEXT,
  due_date TIMESTAMPTZ,
  overdue_notified_at TIMESTAMPTZ, -- v27: dedup do alerta Telegram de atraso — notifica 1x por vencimento
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_board_column ON tasks(board_column);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_store ON tasks(store_id);
CREATE INDEX IF NOT EXISTS idx_tasks_rule_item_open ON tasks(rule_key, item_id) WHERE board_column != 'excluido';

CREATE TABLE IF NOT EXISTS task_comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);

-- v21 — Embalagem: gravação de vídeo de conferência ao bipar etiqueta.
-- Ver .claude/embalagem.md.
CREATE TABLE IF NOT EXISTS packing_videos (
  id BIGSERIAL PRIMARY KEY,
  shipping_id TEXT NOT NULL,
  order_ids TEXT[] NOT NULL,
  file_path TEXT NOT NULL,
  duration_seconds INT,
  store_id BIGINT REFERENCES stores(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_packing_videos_shipping ON packing_videos(shipping_id);
CREATE INDEX IF NOT EXISTS idx_packing_videos_created ON packing_videos(created_at);
CREATE INDEX IF NOT EXISTS idx_packing_videos_order_ids ON packing_videos USING GIN(order_ids);

-- v22 — Login de acesso restrito (staff). Ver .claude/auth-staff.md.
CREATE TABLE IF NOT EXISTS staff_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- admin | embalagem
  created_at TIMESTAMPTZ DEFAULT now()
);

-- v25 — Qualidade de Anúncio: SEO Score próprio. Ver .claude/decisions.md.
CREATE TABLE IF NOT EXISTS item_seo_score (
  id SERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT UNIQUE REFERENCES items(ml_id),
  category_id TEXT,
  brand TEXT,
  pictures_count INT,
  has_video BOOLEAN,
  title_length INT,
  description_word_count INT,
  has_gtin BOOLEAN,
  has_brand BOOLEAN,
  has_model BOOLEAN,
  is_full BOOLEAN,
  shipping_type TEXT,
  catalog_listing BOOLEAN,
  required_attrs_total INT,
  required_attrs_missing INT,
  missing_required_attrs TEXT[],
  visits_30d INT,
  sales_30d INT,
  conversion_rate NUMERIC,
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

CREATE TABLE IF NOT EXISTS category_attributes_cache (
  category_id TEXT PRIMARY KEY,
  required_ids TEXT[],
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- v26 — Monitor de Buy-Box / Concorrência de Catálogo. Ver .claude/decisions.md.
CREATE TABLE IF NOT EXISTS catalog_competition (
  id SERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  item_id TEXT UNIQUE REFERENCES items(ml_id),
  catalog_product_id TEXT,
  status TEXT,
  current_price NUMERIC,
  price_to_win NUMERIC,
  winner_item_id TEXT,
  winner_price NUMERIC,
  boosts_missing TEXT[],
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
