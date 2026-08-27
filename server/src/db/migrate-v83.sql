-- v83: business_insights — status/histórico das Ações Recomendadas (Inteligência de Margem).
--
-- FinanceEcom Fase F (spec de 12 seções). As ações em si continuam 100%
-- calculadas a cada request (`computarMargem()`, routes/bi.js) — nunca
-- persistidas como "verdade", já que dependem do período/filtro escolhido.
-- Esta tabela guarda só o que NÃO pode ser recalculado: se a analista já
-- viu/tratou aquela recomendação. Identidade estável = (item_id, tipo) —
-- a mesma dupla continua "a mesma ação" mesmo que o impacto_estimado mude
-- de um período pro outro.
--
-- Deliberadamente SEM feedback loop automático (medir resultado real
-- pós-ação e atribuir causalidade) — decisão já tomada 2x antes pro mesmo
-- motivo (ver decisions.md "Inteligência de Margem"): sem uso real
-- acumulado ainda, e o próprio pedido do usuário exige nunca afirmar
-- causalidade sem evidência (mesmo princípio já aplicado ao "antes×depois"
-- de Recuperação em rankeamento). status/nota aqui são só o que a pessoa
-- registrou manualmente, nunca um efeito inferido.
CREATE TABLE IF NOT EXISTS business_insights (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  tipo TEXT NOT NULL,                 -- mesmo valor de acoes[].tipo (PAUSAR_OU_RENEGOCIAR, REPRECIFICAR, ...)
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | em_andamento | concluida | descartada
  nota TEXT,
  updated_by TEXT,                    -- staff_user_name de quem mudou por último (auth-staff.md)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_business_insights_item ON business_insights (item_id);
