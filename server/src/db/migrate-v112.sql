-- v112: página Expedição (pages/expedicao.html) — horário de corte (SLA de
-- despacho) por pedido. Ver .claude/embalagem.md e .claude/workers.md
-- (syncShipmentSla).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_cutoff TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_checked_at TIMESTAMPTZ;
