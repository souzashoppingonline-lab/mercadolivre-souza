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
--    CORRIGIDO (v121): o UPDATE simples quebrava em TODO deploy depois da 1ª
--    execução ("duplicate key ... returns_claim_id_uidx") quando aparecia uma
--    linha com claim_id NULL cujo raw_data->>'id' já era o claim_id de outra
--    linha — e, por rodar num bloco só, a migration inteira era desfeita e a
--    devolução ficava DUPLICADA na tela. Agora:
--    2a. preenche claim_id só em UMA linha por reclamação, e só se ninguém
--        ainda tem esse claim_id;
--    2b. as sobras (NULL com o mesmo id de uma reclamação que já tem linha)
--        são juntadas na linha existente (passo 3, junto das duplicatas).
WITH cand AS (
  SELECT DISTINCT ON (raw_data->>'id') id, raw_data->>'id' AS cid
    FROM returns r
   WHERE claim_id IS NULL AND raw_data->>'id' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM returns x WHERE x.claim_id = r.raw_data->>'id')
   ORDER BY raw_data->>'id', COALESCE(updated_at, date) DESC NULLS LAST, id DESC
)
UPDATE returns r SET claim_id = c.cid FROM cand c WHERE r.id = c.id;

-- 3. Colapsar as duplicatas: manter UMA linha por reclamação e apagar as
--    cópias, preservando os campos MANUAIS (prejuizo, note, abertura_chamado)
--    digitados em qualquer cópia. "Cópia" = outra linha com o mesmo claim_id
--    OU linha sem claim_id com raw_data->>'id' igual (sobra do passo 2).
--    Fica a linha que TEM claim_id (é a que o upsertClaim mantém atualizada);
--    entre várias, a mais recente. Vídeo de devolução (return_videos, v117,
--    sem FK) é repontado pra linha que fica antes do DELETE. Idempotente:
--    sem cópias, vira no-op.
CREATE TEMP TABLE IF NOT EXISTS _v59_dup (dup_id BIGINT PRIMARY KEY, keep_id BIGINT NOT NULL);
TRUNCATE _v59_dup;
WITH grupo AS (
  SELECT id, COALESCE(claim_id, raw_data->>'id') AS cid,
         (claim_id IS NOT NULL) AS tem_cid, COALESCE(updated_at, date) AS quando
    FROM returns
   WHERE claim_id IS NOT NULL OR raw_data->>'id' IS NOT NULL
), keep AS (
  SELECT DISTINCT ON (cid) cid, id AS keep_id
    FROM grupo
   ORDER BY cid, tem_cid DESC, quando DESC NULLS LAST, id DESC
)
INSERT INTO _v59_dup (dup_id, keep_id)
SELECT g.id, k.keep_id
  FROM grupo g JOIN keep k ON k.cid = g.cid
 WHERE g.id <> k.keep_id
   AND EXISTS (SELECT 1 FROM grupo t WHERE t.cid = g.cid AND t.tem_cid);  -- só reclamação que já tem linha "oficial"

WITH m AS (
  SELECT d.keep_id,
         (array_agg(r.prejuizo) FILTER (WHERE r.prejuizo IS NOT NULL))[1]            AS m_prejuizo,
         (array_agg(r.note)     FILTER (WHERE r.note IS NOT NULL AND r.note <> ''))[1] AS m_note,
         bool_or(COALESCE(r.abertura_chamado, false))                               AS m_abertura
    FROM _v59_dup d JOIN returns r ON r.id = d.dup_id
   GROUP BY d.keep_id
)
UPDATE returns r SET
  prejuizo         = COALESCE(r.prejuizo, m.m_prejuizo),
  note             = COALESCE(NULLIF(r.note, ''), m.m_note),
  abertura_chamado = COALESCE(r.abertura_chamado, false) OR m.m_abertura
FROM m
WHERE r.id = m.keep_id;

DO $$
BEGIN
  IF to_regclass('public.return_videos') IS NOT NULL THEN
    UPDATE return_videos v SET return_id = d.keep_id FROM _v59_dup d WHERE v.return_id = d.dup_id;
  END IF;
END $$;

DELETE FROM returns r USING _v59_dup d WHERE r.id = d.dup_id;
DROP TABLE _v59_dup;

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
