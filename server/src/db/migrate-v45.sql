-- v45: Relatórios de Embalagem — autenticação + breakdown por embalador/marketplace
-- Rastreia quem embalou cada pedido (staff_user_id) pra relatórios de produtividade

ALTER TABLE packing_videos ADD COLUMN IF NOT EXISTS staff_user_id BIGINT;
ALTER TABLE packing_videos ADD COLUMN IF NOT EXISTS staff_user_name TEXT;

CREATE INDEX IF NOT EXISTS idx_packing_videos_staff_user ON packing_videos(staff_user_id, created_at DESC);
