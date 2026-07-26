-- v50 — Análise de Produtos (Fase 1): cadastro de produto com custos + anúncios
-- concorrentes coletados pela extensão + fila de "produto ativo para coleta".
-- Ver .claude/analise-produtos.md.

CREATE TABLE IF NOT EXISTS analise_products (
  id            BIGSERIAL PRIMARY KEY,
  produto       TEXT NOT NULL,
  fornecedor    TEXT,
  preco_compra  NUMERIC,
  taxa_mp       NUMERIC,        -- % taxa do marketplace
  imposto       NUMERIC,        -- % imposto
  frete_entrada NUMERIC,        -- R$ frete de entrada (compra)
  embalagem     NUMERIC,        -- R$ embalagem
  observacoes   TEXT,
  status        TEXT NOT NULL DEFAULT 'EM_ANALISE',  -- EM_ANALISE | ANALISADO
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Anúncios concorrentes coletados pela extensão, associados ao produto.
-- O payload cru completo fica em `raw`; os campos "achatados" são pra listar/agregar.
CREATE TABLE IF NOT EXISTS analise_product_ads (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES analise_products(id) ON DELETE CASCADE,
  ml_id          TEXT,           -- id do anúncio no ML (dedup por produto)
  titulo         TEXT,
  preco          NUMERIC,
  preco_original NUMERIC,
  nota           NUMERIC,
  vendas         TEXT,           -- "+500" etc — a Shopee/ML devolve texto
  perguntas      INT,
  comentarios    INT,
  vendedor       TEXT,
  cidade         TEXT,
  estado         TEXT,
  reputacao      TEXT,
  is_full        BOOLEAN,        -- "full" é palavra reservada no Postgres → is_full
  is_flex        BOOLEAN,
  fotos          JSONB,
  videos         JSONB,
  raw            JSONB,          -- payload cru completo da extensão
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_id, ml_id)
);
CREATE INDEX IF NOT EXISTS idx_analise_ads_product ON analise_product_ads(product_id);

-- Um ÚNICO produto "ativo para coleta" por vez (linha fixa id=1). A extensão lê
-- daqui qual produto está ativo — nunca pergunta ao usuário.
CREATE TABLE IF NOT EXISTS analise_active_collection (
  id          INT PRIMARY KEY DEFAULT 1,
  product_id  BIGINT REFERENCES analise_products(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT analise_active_single_row CHECK (id = 1)
);
INSERT INTO analise_active_collection (id, product_id) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
