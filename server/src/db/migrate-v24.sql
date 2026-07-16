-- v24 — dados completos da claim (stage/type/players/last_updated) e cache
-- de tradução de reason_id, pra mostrar a devolução traduzida na tela sem
-- rechamar a API do ML pra cada linha (rate limit real observado nesta
-- sessão). Ver .claude/decisions.md.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS raw_data JSONB;

CREATE TABLE IF NOT EXISTS claim_reasons (
  id TEXT PRIMARY KEY,
  detail TEXT,
  flow TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
