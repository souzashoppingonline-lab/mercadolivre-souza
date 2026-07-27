-- v56 — Gastos de IA: registra o custo de cada chamada (tokens × preço) e guarda
-- o saldo informado pelo usuário pra estimar quanto ainda dá. A API padrão da
-- Anthropic NÃO expõe o saldo da conta, então o saldo é digitado à mão e a
-- estimativa usa o custo médio real medido aqui. Ver .claude/analise-produtos.md.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  model TEXT,
  feature TEXT,               -- 'analise' | 'criativos' | ...
  product_id BIGINT,
  input_tokens INT,
  output_tokens INT,
  cost_usd NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);

CREATE TABLE IF NOT EXISTS ai_settings (
  id INT PRIMARY KEY DEFAULT 1,
  balance_usd NUMERIC,
  balance_set_at TIMESTAMPTZ,
  CONSTRAINT ai_settings_one CHECK (id = 1)
);
INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
