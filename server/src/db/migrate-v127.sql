-- v127: Extrato Bancário (OFX) — Financeiro → "Extrato Bancário (OFX)".
-- Postgres do servidor (não Supabase), mesmo padrão de conta_saldos_informados
-- (v118). Ver .claude/extrato-ofx.md.

-- Conta bancária identificada no OFX (banco + agência + conta). '' em vez de
-- NULL nos campos da chave pra o UNIQUE funcionar (NULL nunca conflita).
CREATE TABLE IF NOT EXISTS ofx_contas (
  id          SERIAL PRIMARY KEY,
  banco_id    TEXT NOT NULL DEFAULT '',
  banco_nome  TEXT,
  agencia     TEXT NOT NULL DEFAULT '',
  conta       TEXT NOT NULL,
  tipo_conta  TEXT,
  apelido     TEXT,
  criado_em   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (banco_id, agencia, conta)
);

-- Cada arquivo importado. saldo_final = <LEDGERBAL> do OFX (saldo no fim do período).
CREATE TABLE IF NOT EXISTS ofx_importacoes (
  id             SERIAL PRIMARY KEY,
  conta_id       INT REFERENCES ofx_contas(id) ON DELETE CASCADE,
  arquivo_nome   TEXT,
  dt_inicio      DATE,
  dt_fim         DATE,
  saldo_final    NUMERIC(14,2),
  saldo_final_em DATE,
  lidos          INT,
  novos          INT,
  importado_por  TEXT,
  importado_em   TIMESTAMPTZ DEFAULT now()
);

-- Lançamentos. `chave` = hash de data|valor|descrição|nº da ocorrência no
-- arquivo — o FITID do Santander muda a cada exportação (traz a data/hora do
-- export), então não serve pra ignorar o mesmo período importado 2×.
CREATE TABLE IF NOT EXISTS ofx_lancamentos (
  id                BIGSERIAL PRIMARY KEY,
  conta_id          INT NOT NULL REFERENCES ofx_contas(id) ON DELETE CASCADE,
  chave             TEXT NOT NULL,
  fitid             TEXT,
  data              DATE NOT NULL,
  valor             NUMERIC(14,2) NOT NULL,
  tipo              TEXT,
  descricao         TEXT,
  contraparte       TEXT,
  contraparte_chave TEXT,
  categoria         TEXT,
  categoria_origem  TEXT NOT NULL DEFAULT 'auto',  -- auto | aprendido | manual
  importacao_id     INT REFERENCES ofx_importacoes(id) ON DELETE SET NULL,
  criado_em         TIMESTAMPTZ DEFAULT now(),
  UNIQUE (conta_id, chave)
);
CREATE INDEX IF NOT EXISTS ofx_lancamentos_data_idx ON ofx_lancamentos (data);
CREATE INDEX IF NOT EXISTS ofx_lancamentos_conta_data_idx ON ofx_lancamentos (conta_id, data);
CREATE INDEX IF NOT EXISTS ofx_lancamentos_cp_idx ON ofx_lancamentos (contraparte_chave);

-- O que o usuário ensinou: categoria (e nome amigável) por contraparte —
-- vale pros lançamentos passados e futuros da mesma contraparte.
CREATE TABLE IF NOT EXISTS ofx_regras (
  contraparte_chave TEXT PRIMARY KEY,
  categoria         TEXT,
  apelido           TEXT,
  atualizado_por    TEXT,
  atualizado_em     TIMESTAMPTZ DEFAULT now()
);

-- Resumo mensal SALVO (pedido do usuário: visão mês a mês). Regravado a cada
-- importação/correção de categoria (salvarResumosMensais); conta_id 0 = todas.
CREATE TABLE IF NOT EXISTS ofx_resumos_mensais (
  mes           TEXT NOT NULL,
  conta_id      INT NOT NULL DEFAULT 0,
  entradas      NUMERIC(14,2),
  saidas        NUMERIC(14,2),
  resultado     NUMERIC(14,2),
  saldo_inicial NUMERIC(14,2),
  saldo_final   NUMERIC(14,2),
  menor_saldo   NUMERIC(14,2),
  tarifas       NUMERIC(14,2),
  lancamentos   INT,
  sem_categoria INT,
  categorias    JSONB,          -- { entradas:[{categoria,total}], saidas:[{categoria,total}] } (inclui as "fora do total")
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (mes, conta_id)
);

-- Última análise da IA por mês (conta_id 0 = todas as contas).
CREATE TABLE IF NOT EXISTS ofx_analises_ia (
  mes       TEXT NOT NULL,
  conta_id  INT NOT NULL DEFAULT 0,
  analise   JSONB NOT NULL,
  modelo    TEXT,
  gerado_em TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (mes, conta_id)
);
