-- Busca por rastreio parcial na aba "Buscar vídeos" do Embalagem (GET
-- /api/embalagem/videos) — ILIKE '%x%' não usa o índice btree existente
-- (idx_packing_videos_shipping), precisa de trigram pra continuar rápido.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_packing_videos_shipping_trgm ON packing_videos USING GIN (shipping_id gin_trgm_ops);
