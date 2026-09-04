-- v92 — Analista Ecom: nome REAL da categoria (não o category_id numérico)
-- no filtro de categoria. Mesmo padrão de cache-por-categoria já usado em
-- category_attributes_cache (v25) — populado pelo worker (sync-seo-score,
-- que já itera categoria por item todo dia), nunca por uma rota HTTP de
-- leitura (regra de arquitetura: mlClient.js só é chamado de dentro do
-- worker ou de ações pontuais em rotas, nunca em leituras de listagem).
--
-- Sem TTL de expiração (diferente de category_attributes_cache, que expira
-- em 30 dias) — o NOME de uma categoria do Mercado Livre praticamente nunca
-- muda, então uma vez cacheado não vale a pena rechamar a API só pra
-- confirmar o mesmo valor; só é preenchido quando ainda não existe linha
-- pra aquela categoria.
CREATE TABLE IF NOT EXISTS category_names_cache (
  category_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
