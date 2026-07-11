-- Marketplace Engine — Fase 1: tabela `marketplaces`, coluna discriminadora
-- `marketplace_id` nas tabelas compartilhadas, e infraestrutura de ingestão
-- por polling (Amazon). Não normaliza order_items/products/inventory/
-- shipments/customers (fase futura) e não altera nenhum handler do
-- pipeline Mercado Livre. Ver .claude/decisions.md.

CREATE TABLE IF NOT EXISTS marketplaces (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  api_type TEXT,            -- 'webhook' | 'polling'
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO marketplaces (code, name, api_type, enabled) VALUES
  ('ML',     'Mercado Livre', 'webhook', true),
  ('AMAZON', 'Amazon',        'polling', true),
  ('SHOPEE', 'Shopee',        'webhook', false),
  ('MAGALU', 'Magalu',        'polling', false),
  ('TIKTOK', 'TikTok',        'polling', false)
ON CONFLICT (code) DO NOTHING;

-- Coluna discriminadora nas tabelas compartilhadas, com backfill para ML
-- (todo dado já existente no banco é Mercado Livre).
ALTER TABLE stores   ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE items    ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS marketplace_id INT REFERENCES marketplaces(id);

UPDATE stores   SET marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') WHERE marketplace_id IS NULL;
UPDATE orders   SET marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') WHERE marketplace_id IS NULL;
UPDATE items    SET marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') WHERE marketplace_id IS NULL;
UPDATE messages SET marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') WHERE marketplace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_items_marketplace   ON items(marketplace_id);
CREATE INDEX IF NOT EXISTS idx_stores_marketplace  ON stores(marketplace_id);

-- orders.ml_id era BIGINT (só cabiam IDs numéricos do ML). IDs de pedido da
-- Amazon (ex: "902-1845936-3456781") não são numéricos — precisa ser TEXT.
-- Seguro: ml_id é usado em todo o código só como chave opaca de
-- igualdade/join, nunca em ORDER BY/aritmética (verificado em api.js/worker.js).
-- schema.sql já faz essa mesma conversão (roda antes deste arquivo) — este
-- bloco é só uma rede de segurança para quem rodar migrate-v15.sql isolado.
-- Precisa do guard "IF ... <> 'text'": depois que schema.sql cria a view
-- vw_ml_orders (v17) sobre orders.ml_id, um ALTER COLUMN TYPE aqui — mesmo
-- sendo um no-op (TEXT → TEXT) — quebra com "cannot alter type of a column
-- used by a view" porque o Postgres não permite ALTER COLUMN TYPE em coluna
-- referenciada por view/rule, independente do tipo mudar de fato ou não.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'ml_id') <> 'text' THEN
    ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_order_id_fkey;
    ALTER TABLE orders  ALTER COLUMN ml_id    TYPE TEXT USING ml_id::TEXT;
    ALTER TABLE returns ALTER COLUMN order_id TYPE TEXT USING order_id::TEXT;
    ALTER TABLE returns ADD CONSTRAINT returns_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(ml_id);
  END IF;
END $$;

-- Campos exclusivos de pedidos Amazon — `orders` continua só com os campos
-- comuns entre marketplaces.
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

-- Cursor de "última sincronização" para EventSources baseados em polling
-- (Amazon hoje; qualquer marketplace de polling futuro reaproveita).
-- Não confundir com schedule_jobs/schedule_runs (status de execução de cron,
-- não cursor de dados).
CREATE TABLE IF NOT EXISTS marketplace_sync_state (
  marketplace_id INT NOT NULL REFERENCES marketplaces(id),
  source_key TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (marketplace_id, source_key)
);

-- Store sentinela para a conta Amazon — só uma conta configurada hoje
-- (server/.env), sem descoberta dinâmica de lojas como o ML tem. ID fixo
-- fora da faixa de IDs numéricos reais de usuário ML.
INSERT INTO stores (id, nickname, marketplace_id)
VALUES (9000000001, 'Amazon', (SELECT id FROM marketplaces WHERE code = 'AMAZON'))
ON CONFLICT (id) DO NOTHING;
