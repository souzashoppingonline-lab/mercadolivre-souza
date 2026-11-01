-- v128: cards do "Mês a mês" (Extrato Bancário OFX) mostram quantos alertas o mês teve.
ALTER TABLE ofx_resumos_mensais ADD COLUMN IF NOT EXISTS alertas INT;
