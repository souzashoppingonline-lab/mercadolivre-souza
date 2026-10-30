-- v124: Frase do dia da Tela Telegram — criada por IA 1x por dia, nunca repete
-- (o histórico inteiro fica aqui e é usado pra checar repetição). Ver
-- server/src/fraseDoDia.js e .claude/frontend.md.
CREATE TABLE IF NOT EXISTS frases_do_dia (
  dia DATE PRIMARY KEY,
  frase TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT 'ia',      -- ia | reserva (lista fixa, quando a IA não está configurada/falhou)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
