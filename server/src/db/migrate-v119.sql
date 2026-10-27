-- Buy Box no Telegram (v119). Ver .claude/workers.md.
-- buybox_mudancas: cada alteração detectada ao gravar catalog_competition
-- (catalogCompetition.js — sync diário/intradia, webhook, Rankeamento). Fica
-- pendente (enviado_em NULL) até o flushBuyboxMudancas (10 em 10 min, fora do
-- silêncio) mandar no Telegram agrupado por empresa. tipo: status |
-- preco_vencedor | novo_vencedor | seu_preco.
CREATE TABLE IF NOT EXISTS buybox_mudancas (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT,
  item_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  de TEXT,
  para TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS buybox_mudancas_pendentes_idx ON buybox_mudancas (created_at) WHERE enviado_em IS NULL;

-- buybox_alerta_estado: status de cada anúncio no último RELATÓRIO diário
-- (08:30) — base do bloco "mudou desde o último relatório".
CREATE TABLE IF NOT EXISTS buybox_alerta_estado (
  item_id TEXT PRIMARY KEY,
  chave TEXT NOT NULL,
  reportado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
