-- v129: mês de competência do lançamento (Extrato OFX). Conta paga no fim do mês
-- que o banco só compensou no 1º dia útil seguinte (ex.: sáb 31/10 → seg 03/11)
-- conta no mês certo nos totais/fechamento. NULL = mês da data do banco.
-- O saldo dia a dia continua pela data (é o saldo real do banco).
ALTER TABLE ofx_lancamentos ADD COLUMN IF NOT EXISTS mes_competencia TEXT;
