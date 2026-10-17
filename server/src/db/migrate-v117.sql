-- Vídeo de devolução (v117): o analista grava, na página Devoluções, a
-- abertura do pacote devolvido (produto diferente/quebrado/faltando) pra
-- usar como prova na disputa com o Mercado Livre. Arquivo em
-- server/storage/devolucao-videos/YYYY-MM-DD/; retenção 90 dias (job
-- cleanupReturnVideos). Ver .claude/embalagem.md ("Vídeo de devolução").
CREATE TABLE IF NOT EXISTS return_videos (
  id SERIAL PRIMARY KEY,
  return_id BIGINT NOT NULL,          -- returns.id (sem FK: apagar a devolução não trava; a limpeza de 90 dias cuida do arquivo)
  order_id TEXT,                      -- copiado de returns no upload (busca/nome do arquivo)
  claim_id TEXT,
  file_path TEXT NOT NULL,
  mime TEXT,                          -- video/mp4 (preferido) ou video/webm
  file_size BIGINT,
  duration_seconds INT,
  staff_user_name TEXT,
  observacao TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_videos_return_idx ON return_videos (return_id);
CREATE INDEX IF NOT EXISTS return_videos_created_idx ON return_videos (created_at);

-- Link público de um vídeo (devolução ou embalagem) pra mandar pro ML/cliente
-- sem login: token aleatório de 32 hex, criado sob demanda no "Copiar link".
-- Lido por GET /api/publico/video/:token (prefixo público em staffAuth.js).
-- Some junto com o vídeo (limpeza) — link de vídeo apagado responde 404.
CREATE TABLE IF NOT EXISTS video_links (
  token TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('devolucao', 'embalagem')),
  video_id INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tipo, video_id)
);
