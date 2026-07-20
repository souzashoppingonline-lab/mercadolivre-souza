-- v40 — custo do produto Shopee, por variação (a Shopee não fornece custo; o
-- usuário digita na tela do Precificador). Tabela SEPARADA de shopee_item_data
-- de propósito: o sync de catálogo (syncShopeeCatalog) reescreve os models a
-- cada 30min, então o custo não pode morar lá senão seria apagado. Por
-- (item_id, model_id) porque variações (ex: 1/2/3/4 peças) têm custos diferentes.
CREATE TABLE IF NOT EXISTS shopee_item_cost (
  item_id TEXT NOT NULL,
  model_id BIGINT NOT NULL DEFAULT 0,   -- 0 = item sem variação
  cost NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_shopee_item_cost_item ON shopee_item_cost(item_id);
