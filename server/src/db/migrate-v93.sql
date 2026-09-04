-- v93 — Analista Ecom: frete POR ANÚNCIO, não só global. Pedido do usuário
-- depois de já ter um botão de editar frete que mudava o padrão pra TODOS
-- os anúncios de uma vez — mesmo padrão já usado pra margem alvo (v91):
-- items.frete NUMERIC, NULL = sem override, usa o frete padrão global
-- (app_config) — nunca um valor copiado silenciosamente pro item.
ALTER TABLE items ADD COLUMN IF NOT EXISTS frete NUMERIC;

-- `vw_ml_items` (schema.sql) é `SELECT * FROM items ...` — o conjunto de
-- colunas da view fica CONGELADO no CREATE (mesmo sendo "SELECT *"), mesmo
-- padrão já corrigido nas v84/v89/v91. Sem isto, `i.frete` (analistaEcom.js)
-- quebraria com "column does not exist" até o PRÓXIMO `npm run migrate`.
CREATE OR REPLACE VIEW vw_ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
