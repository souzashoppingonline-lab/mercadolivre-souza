-- v89 — corrige o bug real: items.cost tem DEFAULT 0 (schema.sql), então um
-- item recém-sincronizado (INSERT em handleItem, worker.js) já nasce com
-- cost=0 — indistinguível de "usuário confirmou que o custo é R$0,00 de
-- verdade" (ex.: brinde). A tarja amarela de "custo não cadastrado" em
-- bi-vendas.html (v88.x) usava `cost IS NULL`, que quase nunca é verdadeiro
-- na prática (só item nunca sincronizado tem cost NULL) — por isso não
-- aparecia mesmo com o custo visivelmente zerado. Ver decisions.md.
--
-- cost_updated_at só é gravado pelas 2 rotas que um HUMANO usa pra definir
-- custo (PATCH /items/:id/custo e PATCH /custos/:sku) — nunca pelo sync do
-- worker. NULL = "ninguém nunca confirmou o custo deste anúncio", mesmo que
-- a coluna cost já esteja em 0 pelo DEFAULT da tabela.
ALTER TABLE items ADD COLUMN IF NOT EXISTS cost_updated_at TIMESTAMPTZ;

-- `vw_ml_items` (schema.sql) é `SELECT * FROM items ...` — o conjunto de
-- colunas da view fica CONGELADO no CREATE, mesmo sendo "SELECT *"
-- (schema.sql roda ANTES desta migration, é o 1º arquivo da lista de
-- migrate.js). Sem isto, `i.cost_updated_at` (vendaMargem.js) quebraria com
-- "column does not exist" até o PRÓXIMO `npm run migrate` — mesmo padrão já
-- usado na v84 pra `vw_ml_orders.tarifa_manual`. Ver known-bugs.md.
CREATE OR REPLACE VIEW vw_ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
