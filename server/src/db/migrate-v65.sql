-- v65: relatório de erros de embalagem — registra toda falha ao salvar o vídeo
-- de conferência (upload/disco, arquivo ausente, insert no banco), com o tipo,
-- pedido(s), loja, embalador e data/hora. Ver .claude/embalagem.md.
CREATE TABLE IF NOT EXISTS embalagem_errors (
  id BIGSERIAL PRIMARY KEY,
  error_type      TEXT,          -- upload | video_grande | arquivo_ausente | sem_shipping_id | db_insert | ...
  shipping_id     TEXT,
  order_ids       TEXT[],
  store_id        BIGINT,
  store_nickname  TEXT,
  staff_user_name TEXT,
  detail          TEXT,          -- mensagem do erro
  file_path       TEXT,          -- caminho do arquivo gravado (se chegou a salvar) — pra recuperar manualmente
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_embalagem_errors_created ON embalagem_errors(created_at DESC);
