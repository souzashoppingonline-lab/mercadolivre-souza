-- v132: memória da margem de cada venda (aba "Recebíveis Mercado Pago API").
-- 1 linha por pedido: o que o Mercado Pago pagou (recebido) + a margem calculada
-- pela fórmula única (vendaMargem.js). Congela quando o dinheiro é liberado
-- (custo/imposto da época), exceto venda sem custo cadastrado. Gravada por
-- margemVendas.gravarMemoria() (worker 05:35 + boot). Ver .claude/database.md.
CREATE TABLE IF NOT EXISTS margem_vendas_memoria (
  order_id       TEXT PRIMARY KEY,
  store_id       BIGINT,
  item_id        TEXT,
  title          TEXT,
  sku            TEXT,
  data_venda     TIMESTAMPTZ,
  data_liberacao TIMESTAMPTZ,
  liberado       BOOLEAN NOT NULL DEFAULT false,
  qtd            INT,
  faturamento    NUMERIC,
  bruto          NUMERIC,
  recebido       NUMERIC,
  custo          NUMERIC,
  imposto        NUMERIC,
  tarifa         NUMERIC,
  frete          NUMERIC,
  margem         NUMERIC,
  mc_pct         NUMERIC,
  custo_ausente  BOOLEAN NOT NULL DEFAULT true,
  fonte_taxa     TEXT,
  alertas        TEXT[] NOT NULL DEFAULT '{}',
  retroativo     BOOLEAN NOT NULL DEFAULT false,
  gravado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_margem_mem_data_venda ON margem_vendas_memoria (data_venda);
CREATE INDEX IF NOT EXISTS idx_margem_mem_item ON margem_vendas_memoria (item_id);
