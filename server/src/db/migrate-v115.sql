-- Importador Metrizap (v115, pedido explícito do usuário) — substitui o
-- Mercado Turbo como fonte de dado de "Vendas e Custos" (pages/vendas.html).
-- Ver .claude/finance.md.

-- Empresas/contas cadastradas manualmente (o Excel só traz o ID numérico da
-- conta, ex. "1662123376" — não um nome amigável).
CREATE TABLE IF NOT EXISTS metrizap_contas (
  id SERIAL PRIMARY KEY,
  conta TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  marketplace TEXT DEFAULT 'Mercado Livre',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Uma linha por venda, igual a aba "Vendas" do Excel exportado pelo Metrizap.
-- UNIQUE(conta, pedido) é a chave do UPSERT no reimport — não UNIQUE(pedido)
-- sozinho, porque com múltiplas empresas/marketplaces (ML, TikTok Shop,
-- Amazon) o número do pedido não é garantidamente único entre contas.
CREATE TABLE IF NOT EXISTS metrizap_sales (
  id SERIAL PRIMARY KEY,
  pedido TEXT NOT NULL,
  data_venda TIMESTAMPTZ,
  marketplace TEXT,
  conta TEXT,
  pacote TEXT,
  item_id TEXT,
  sku TEXT,
  produto TEXT,
  quantidade INT DEFAULT 1,
  situacao TEXT,
  status_marketplace TEXT,
  venda_afiliado BOOLEAN DEFAULT false,
  comissao_afiliado NUMERIC DEFAULT 0,
  logistica TEXT,
  comprador TEXT,
  valor_pago_comprador NUMERIC DEFAULT 0,
  faturamento NUMERIC DEFAULT 0,
  tarifa NUMERIC DEFAULT 0,
  frete_vendedor NUMERIC DEFAULT 0,
  frete_comprador NUMERIC DEFAULT 0,
  imposto NUMERIC DEFAULT 0,
  custo_produto NUMERIC DEFAULT 0,
  prejuizo_devolucao NUMERIC DEFAULT 0,
  motivo_prejuizo TEXT,
  lucro NUMERIC DEFAULT 0,
  margem_pct NUMERIC DEFAULT 0,
  link_anuncio TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(conta, pedido)
);
CREATE INDEX IF NOT EXISTS idx_metrizap_sales_data      ON metrizap_sales(data_venda DESC);
CREATE INDEX IF NOT EXISTS idx_metrizap_sales_conta     ON metrizap_sales(conta);
CREATE INDEX IF NOT EXISTS idx_metrizap_sales_sku       ON metrizap_sales(sku);
CREATE INDEX IF NOT EXISTS idx_metrizap_sales_situacao  ON metrizap_sales(situacao);

-- Ads/Publicidade não vem na planilha Metrizap — cadastro manual por
-- empresa+dia (pedido explícito do usuário), entra no cálculo de ROI do
-- Resumo. UNIQUE(conta, data_ref): um valor por empresa por dia, reimportar
-- o mesmo dia atualiza em vez de duplicar.
CREATE TABLE IF NOT EXISTS metrizap_ads_manual (
  id SERIAL PRIMARY KEY,
  conta TEXT NOT NULL,
  data_ref DATE NOT NULL,
  valor NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(conta, data_ref)
);
