-- v80: 4º estágio "recuperação" — anúncio que NÃO vende, em intervenção
-- (ADS/título/palavras-chave/fotos) até destravar ou ser encerrado.
-- Ver .claude/rankeamento.md e .claude/business-rules.md.

-- Quando entrou na fase (mesmo padrão de monitoramento_started_at, v77) —
-- é o marco que separa "vendas de antes" das "vendas depois da intervenção".
ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS recuperacao_started_at TIMESTAMPTZ;

-- As anotações viram INTERVENÇÕES tipadas e mensuráveis:
--   tipo     → o que foi mexido (titulo|keywords|fotos|descricao|preco|ads|atributos|frete|outro)
--   baseline → foto das métricas NO MOMENTO da alteração ({visitas,conversao,score,vendas,preco,at});
--              o efeito é calculado na leitura (atual − baseline), sem job e sempre fresco.
ALTER TABLE ranking_notes ADD COLUMN IF NOT EXISTS tipo TEXT;
ALTER TABLE ranking_notes ADD COLUMN IF NOT EXISTS baseline JSONB;
