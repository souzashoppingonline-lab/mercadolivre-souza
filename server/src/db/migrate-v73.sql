-- v73 — Ajuste dos ciclos de rankeamento: o contador de vendas é CUMULATIVO
-- (não zera ao trocar de ciclo) e cada ciclo registra a transição de preço
-- (preço anterior → preço atual). Ver .claude/rankeamento.md.

ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS preco_anterior NUMERIC;   -- preço no ciclo anterior (vira o "de")
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS preco_atual NUMERIC;      -- preço definido para o ciclo atual (manual)

ALTER TABLE ranking_ciclos ADD COLUMN IF NOT EXISTS preco_anterior NUMERIC; -- snapshot do preço anterior do ciclo encerrado
ALTER TABLE ranking_ciclos ADD COLUMN IF NOT EXISTS preco_atual NUMERIC;    -- snapshot do preço atual do ciclo encerrado
