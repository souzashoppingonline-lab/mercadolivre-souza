-- v111: acompanhamento de nota fiscal na aba Expedição (ex-Auditoria) do
-- Embalagem — ver .claude/embalagem.md e .claude/workers.md (syncInvoiceStatus).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS nf_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS nf_checked_at TIMESTAMPTZ;
