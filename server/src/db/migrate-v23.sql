-- v23 — returns.buyer_nickname e returns.note já existiam em produção (fora
-- de qualquer migration rastreada, drift de schema) mas nunca tinham sido
-- registradas em schema.sql/migrate.js — bancos novos ficariam sem essas
-- colunas e todo INSERT em returns (worker.js: handlePostPurchase/syncReturns)
-- ou o PATCH de observação (routes/api.js) falhariam. Ver .claude/decisions.md
-- ("Bug corrigido — endpoint de Claims do ML").
ALTER TABLE returns ADD COLUMN IF NOT EXISTS buyer_nickname TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS note TEXT;
