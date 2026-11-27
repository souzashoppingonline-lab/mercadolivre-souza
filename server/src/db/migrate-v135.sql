-- v135: logística atual do anúncio (shipping.logistic_type do ML: fulfillment/self_service/
-- xd_drop_off/...) — base do Monitor do Full (sair do Full / estoque zero no Full).
-- Gravada por handleItem (webhook) e syncPrecos (05:00). Ver .claude/business-rules.md.
ALTER TABLE items ADD COLUMN IF NOT EXISTS logistic_type TEXT;
-- Ponto de partida: a logística que o sync-seo-score (04:30) já guarda por anúncio.
UPDATE items i SET logistic_type = s.shipping_type
  FROM item_seo_score s WHERE s.item_id = i.ml_id AND i.logistic_type IS NULL AND s.shipping_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_logistic_full_idx ON items (logistic_type) WHERE logistic_type = 'fulfillment';
-- Liga o aviso por padrão: a página Monitor mostra chave ausente como "desligada" e, ao salvar,
-- gravaria 'false' sem o usuário ter escolhido (ver GET /api/telegram/config, TG_NOTIF_KEYS).
INSERT INTO app_config (key, value) VALUES ('tg_full', 'true') ON CONFLICT (key) DO NOTHING;
