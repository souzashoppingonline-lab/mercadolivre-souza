-- v69 — Rankeamento de anúncios novos. O usuário marca um anúncio "em
-- rankeamento" (janela crítica de ranqueamento do ML) e o sistema registra
-- CADA venda e CADA alteração (preço/estoque/status/visitas/qualidade/buy-box),
-- notificando na tela (WebSocket) e no Telegram (tópico tg_rankeamento).
-- A cada N vendas (default 5) dispara um marco com resumo de ritmo.
-- Ver .claude/rankeamento.md.

CREATE TABLE IF NOT EXISTS ranking_ads (
  id SERIAL PRIMARY KEY,
  ml_id TEXT NOT NULL UNIQUE REFERENCES items(ml_id) ON DELETE CASCADE,
  store_id BIGINT REFERENCES stores(id),
  title TEXT,
  active BOOLEAN DEFAULT true,          -- false = pausado (para de notificar sem perder o histórico)
  sales_count INT DEFAULT 0,            -- vendas contabilizadas desde que entrou em rankeamento
  first_sale_at TIMESTAMPTZ,
  last_sale_at TIMESTAMPTZ,
  base_price NUMERIC,                   -- preço no momento em que entrou em rankeamento (referência)
  last_price NUMERIC,                   -- último preço conhecido (para detectar mudança)
  last_available_quantity INT,          -- último estoque conhecido
  last_status TEXT,                     -- último status do anúncio (active/paused/closed)
  last_visits INT,                      -- últimas visitas conhecidas (snapshot)
  last_seo_score NUMERIC,               -- última qualidade conhecida (item_seo_score.score)
  last_buybox BOOLEAN,                  -- ganhando o buy-box de catálogo? (winner_item_id = ml_id)
  milestone_every INT DEFAULT 5,        -- a cada quantas vendas dispara o marco
  started_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_ads_active ON ranking_ads(active);

CREATE TABLE IF NOT EXISTS ranking_events (
  id SERIAL PRIMARY KEY,
  ranking_ad_id INT REFERENCES ranking_ads(id) ON DELETE CASCADE,
  ml_id TEXT,
  event_type TEXT,   -- venda | preco | estoque | status | qualidade | buybox | visitas | marco
  message TEXT,      -- texto pronto (mesmo enviado no Telegram/tela)
  detail JSONB,      -- payload estruturado do evento (valores antes/depois, order_id, etc.)
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_events_ad ON ranking_events(ranking_ad_id, created_at DESC);
