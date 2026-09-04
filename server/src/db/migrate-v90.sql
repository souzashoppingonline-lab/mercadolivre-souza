-- v90 — Analista Ecom (Inteligência de Negócio): tarifa % do Mercado Livre
-- por categoria, configurável pelo usuário. Só isso vira tabela nova —
-- frete padrão/imposto/margem alvo/margem mínima são 4 escalares e entram
-- em app_config (key/value livre, já existe, não precisa de migration pra
-- chave nova). Tarifa é por CATEGORIA (política do próprio Mercado Livre,
-- vale pra qualquer loja que liste naquela categoria) — não por store_id.
CREATE TABLE IF NOT EXISTS pricing_category_fees (
  category_id     TEXT PRIMARY KEY,
  category_name   TEXT,             -- cacheado no momento do cadastro (evita lookup toda leitura)
  fee_percentage  NUMERIC NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
