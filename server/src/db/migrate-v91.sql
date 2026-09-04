-- v91 — Analista Ecom: margem alvo POR ANÚNCIO (não só global). Pedido do
-- usuário depois de já ter um botão pra margem alvo global no card: cada
-- anúncio pode ter sua própria meta de margem (ex.: um produto de giro
-- rápido com meta menor, um de nicho com meta maior) — sem isso, o único
-- jeito de "personalizar" seria mudar a config global e afetar TODOS os
-- anúncios de uma vez.
--
-- NULL = sem override, usa a margem alvo global (app_config, mesmo
-- comportamento de antes) — nunca um valor assumido/copiado silenciosamente.
ALTER TABLE items ADD COLUMN IF NOT EXISTS margem_alvo_pct NUMERIC;

-- `vw_ml_items` (schema.sql) é `SELECT * FROM items ...` — o conjunto de
-- colunas da view fica CONGELADO no CREATE (mesmo sendo "SELECT *"), mesmo
-- padrão já corrigido na v84 (vw_ml_orders.tarifa_manual) e na v89
-- (items.cost_updated_at). Sem isto, `i.margem_alvo_pct` (analistaEcom.js)
-- quebraria com "column does not exist" até o PRÓXIMO `npm run migrate`.
CREATE OR REPLACE VIEW vw_ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
