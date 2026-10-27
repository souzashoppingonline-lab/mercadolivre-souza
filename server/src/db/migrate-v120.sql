-- Tela Telegram (v120): cópia de TODA mensagem que o sistema manda ao
-- Telegram (e dos comandos que chegam no bot), pra página
-- pages/tela-telegram.html mostrar no mesmo formato, rolando na TV. O bot do
-- Telegram não consegue ler o histórico do próprio chat — por isso a cópia é
-- feita na hora do envio (server/src/telegramLog.js). Guardado 30 dias
-- (limpeza diária no worker). Ver .claude/frontend.md.
CREATE TABLE IF NOT EXISTS telegram_mensagens (
  id BIGSERIAL PRIMARY KEY,
  topico TEXT,                         -- chave do aviso (tg_vendas, tg_buybox_mudancas, …) ou bot/teste/tarefas
  texto TEXT NOT NULL,
  html BOOLEAN NOT NULL DEFAULT true,  -- parse_mode HTML (false = texto puro)
  direcao TEXT NOT NULL DEFAULT 'saida' CHECK (direcao IN ('saida', 'entrada')),
  autor TEXT,                          -- quem mandou (só direcao='entrada')
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_mensagens_criado_idx ON telegram_mensagens (criado_em DESC);
