-- v122: IA Estrategista de Performance por Anúncio (Inteligência de Negócio →
-- Vendas por Estágio → aba IA Estrategista). Ver .claude/modules.md.
--
-- ia_estrategista_analises: cada "GERAR NOVA ANÁLISE" (LLM) de um anúncio,
-- com o diagnóstico determinístico que a gerou (snapshot) e o hash da
-- entrada — mesma entrada nas últimas 24h devolve a análise salva em vez de
-- chamar a IA de novo (controle de custo).
CREATE TABLE IF NOT EXISTS ia_estrategista_analises (
  id BIGSERIAL PRIMARY KEY,
  ranking_ad_id INT NOT NULL,              -- ranking_ads.id (sem FK: anúncio removido do Rankeamento não apaga o histórico)
  ml_id TEXT,
  periodo_dias INT NOT NULL,
  input_hash TEXT NOT NULL,
  prioridade INT,
  categoria TEXT,                          -- categoria principal (A–G) na hora da análise
  diagnostico JSONB NOT NULL,              -- snapshot do motor determinístico
  ia JSONB,                                -- resposta da IA (null se a IA não estava configurada)
  modelo TEXT,
  criado_por TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ia_estr_analises_ad_idx ON ia_estrategista_analises (ranking_ad_id, created_at DESC);

-- ia_estrategista_acoes: controle de execução das recomendações.
-- executada_em = CARIMBO de quando entrou em 'concluida' (mesma regra de
-- business_insights.concluida_em, v87): base do antes×depois OBSERVADO
-- (associação temporal, nunca causalidade).
CREATE TABLE IF NOT EXISTS ia_estrategista_acoes (
  id BIGSERIAL PRIMARY KEY,
  ranking_ad_id INT NOT NULL,
  ml_id TEXT,
  produto TEXT,
  analise_id BIGINT,
  categoria TEXT,
  problema TEXT,
  acao TEXT NOT NULL,
  responsavel TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','em_execucao','concluida','descartada')),
  observacao TEXT,
  resultado_observado TEXT,
  executada_em TIMESTAMPTZ,
  criado_por TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ia_estr_acoes_ad_idx ON ia_estrategista_acoes (ranking_ad_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ia_estr_acoes_status_idx ON ia_estrategista_acoes (status);
