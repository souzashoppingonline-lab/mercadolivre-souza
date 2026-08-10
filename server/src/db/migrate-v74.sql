-- v74 — Rankeamento: nome da campanha de ADS no card (texto), no lugar do valor
-- de ADS investido. Ver .claude/rankeamento.md.

ALTER TABLE ranking_ads    ADD COLUMN IF NOT EXISTS campanha_nome TEXT;  -- nome da campanha de ADS do ciclo atual (manual)
ALTER TABLE ranking_ciclos ADD COLUMN IF NOT EXISTS campanha_nome TEXT;  -- snapshot do nome da campanha do ciclo encerrado
