-- v81: colunas de EMBALADOR em packing_videos — migration que nunca existiu.
--
-- `POST /api/embalagem/finalizar` insere staff_user_id/staff_user_name desde a
-- feature de relatório por embalador, e `GET /api/embalagem/relatorio` agrupa
-- por staff_user_name — mas nenhuma migration criava as colunas (o embalagem.md
-- atribuía à v45, que na verdade trata de chave composta da Shopee). Num banco
-- criado do zero pelo migrate.js, o INSERT do vídeo falhava e caía no
-- logEmbalagemError('db_insert') — a gravação ficava no disco, sem registro.
--
-- Idempotente: em produção, onde as colunas podem ter sido criadas na mão, não
-- faz nada. Ver .claude/embalagem.md e .claude/known-bugs.md.
ALTER TABLE packing_videos ADD COLUMN IF NOT EXISTS staff_user_id INT;
ALTER TABLE packing_videos ADD COLUMN IF NOT EXISTS staff_user_name TEXT;

-- Consultas do relatório filtram/ordenam por embalador + período.
CREATE INDEX IF NOT EXISTS idx_packing_videos_staff
  ON packing_videos (staff_user_id, created_at DESC);
