-- v63: situação manual da devolução (etiqueta de estágio escolhida à mão na
-- página de Devoluções: mediação, encerrada, dinheiro liberado, etc.). Cada
-- escolha também vira um evento em claim_history (a timeline da reclamação).
ALTER TABLE returns ADD COLUMN IF NOT EXISTS situacao TEXT;
