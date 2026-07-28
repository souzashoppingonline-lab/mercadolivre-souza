-- v59: Reclamações (returns) — chave única por claim_id + histórico separado.
--
-- PROBLEMA: os 3 pontos que gravavam devoluções (handlePostPurchase,
-- sync-metricas, syncReturns) faziam INSERT ... ON CONFLICT DO NOTHING sem
-- nenhuma constraint única em claim_id → cada atualização da mesma reclamação
-- virava uma LINHA NOVA. A tabela `returns` nem tinha coluna claim_id (o id da
-- claim só existia dentro de raw_data->>'id').
--
-- CORREÇÃO: coluna claim_id + índice UNIQUE parcial → o upsert passa a ser
-- ON CONFLICT (claim_id) DO UPDATE. A tabela principal representa o ESTADO
-- ATUAL; toda transição de estado é registrada em `claim_history`.

-- 1. Colunas novas na tabela principal.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS claim_id TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- 2. Backfill do claim_id a partir do JSON já armazenado.
UPDATE returns SET claim_id = raw_data->>'id'
 WHERE claim_id IS NULL AND raw_data->>'id' IS NOT NULL;

-- 3. Colapsar as duplicatas já existentes: manter UMA linha por claim_id
--    (a mais recente por updated_at/date), preservando os campos MANUAIS
--    (prejuizo, note, abertura_chamado) que possam ter sido digitados em
--    qualquer uma das cópias. Nada FK-referencia returns.id, então o DELETE
--    das cópias é seguro. Idempotente: após a 1ª execução não há mais
--    duplicatas, então vira no-op nas migrações seguintes.
WITH grp AS (
  SELECT claim_id,
         (array_agg(id ORDER BY COALESCE(updated_at, date) DESC NULLS LAST, id DESC))[1] AS keep_id,
         (array_agg(prejuizo) FILTER (WHERE prejuizo IS NOT NULL))[1]                     AS m_prejuizo,
         (array_agg(note)     FILTER (WHERE note IS NOT NULL AND note <> ''))[1]          AS m_note,
         bool_or(COALESCE(abertura_chamado, false))                                        AS m_abertura
  FROM returns
  WHERE claim_id IS NOT NULL
  GROUP BY claim_id
  HAVING count(*) > 1
)
UPDATE returns r SET
  prejuizo         = COALESCE(r.prejuizo, g.m_prejuizo),
  note             = COALESCE(NULLIF(r.note, ''), g.m_note),
  abertura_chamado = COALESCE(r.abertura_chamado, false) OR g.m_abertura
FROM grp g
WHERE r.id = g.keep_id;

WITH grp AS (
  SELECT claim_id,
         (array_agg(id ORDER BY COALESCE(updated_at, date) DESC NULLS LAST, id DESC))[1] AS keep_id
  FROM returns
  WHERE claim_id IS NOT NULL
  GROUP BY claim_id
  HAVING count(*) > 1
)
DELETE FROM returns r
USING grp g
WHERE r.claim_id = g.claim_id AND r.id <> g.keep_id;

-- 4. Índice UNIQUE parcial: uma reclamação, uma linha. Parcial (WHERE claim_id
--    IS NOT NULL) pra não bloquear devoluções antigas sem claim_id resolvido.
CREATE UNIQUE INDEX IF NOT EXISTS returns_claim_id_uidx
  ON returns (claim_id) WHERE claim_id IS NOT NULL;

-- 5. Histórico: TODAS as alterações desde a criação da reclamação. A tabela
--    principal não cresce; o histórico sim (um registro por transição real).
CREATE TABLE IF NOT EXISTS claim_history (
  id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL,
  event_type TEXT,          -- created | status_change | stage_change | resolution | note
  status TEXT,
  substatus TEXT,
  description TEXT,          -- texto legível pra timeline ("Reclamação encerrada")
  payload_json JSONB,       -- snapshot da claim naquele momento
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_history_claim_idx ON claim_history (claim_id, created_at);

-- 6. Semente: um evento "criada" pra cada reclamação existente que ainda não
--    tem histórico, pra a timeline não abrir vazia. Usa a data de abertura.
INSERT INTO claim_history (claim_id, event_type, status, description, payload_json, created_at)
SELECT r.claim_id, 'created', r.status, 'Reclamação registrada', r.raw_data,
       COALESCE(r.date, r.updated_at, now())
FROM returns r
WHERE r.claim_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM claim_history h WHERE h.claim_id = r.claim_id);
