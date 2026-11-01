-- v130: arquivo OFX que "atravessa o mês" (começa no mês M e termina até o dia 5 de M+1 —
-- ex.: extrato de outubro do Santander até seg 03/11, por fim de semana + feriado). Os
-- lançamentos de M+1 desse arquivo passam a contar em M (mesma regra de
-- competenciaDoArquivo() em routes/extratoOfx.js, que já vale nas próximas importações).
-- Roda UMA vez (marca em app_config `ofx_v130_competencia`) — as migrations são
-- reexecutadas a cada deploy e isto não pode desfazer uma escolha manual posterior.
-- Ver .claude/extrato-ofx.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_config WHERE key = 'ofx_v130_competencia') THEN
    UPDATE ofx_lancamentos l
       SET mes_competencia = to_char(i.dt_inicio, 'YYYY-MM')
      FROM ofx_importacoes i
     WHERE l.importacao_id = i.id
       AND l.mes_competencia IS NULL
       AND i.dt_inicio IS NOT NULL AND i.dt_fim IS NOT NULL
       AND date_trunc('month', i.dt_fim) = date_trunc('month', i.dt_inicio) + interval '1 month'
       AND EXTRACT(DAY FROM i.dt_fim) <= 5
       AND date_trunc('month', l.data) = date_trunc('month', i.dt_fim)
       AND l.data <= i.dt_fim;
    -- Mês a mês: a tela regrava na próxima abertura (GET /mensal recalcula se estiver vazio).
    DELETE FROM ofx_resumos_mensais;
    INSERT INTO app_config (key, value) VALUES ('ofx_v130_competencia', 'aplicada') ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;
