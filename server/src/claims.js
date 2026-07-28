// Persistência de reclamações (devoluções) do Mercado Livre — ponto ÚNICO de
// gravação, compartilhado entre worker.js (webhook + syncs agendados) e a rota
// de "atualizar status" em routes/api.js.
//
// Regra central (ver .claude/decisions.md): uma reclamação = UMA linha em
// `returns`, chaveada por claim_id (índice UNIQUE parcial, migrate-v59). Toda
// gravação é INSERT ... ON CONFLICT (claim_id) DO UPDATE — nunca INSERT puro,
// nunca cria linha duplicada. A tabela `returns` guarda o ESTADO ATUAL; cada
// transição real de estado gera um registro em `claim_history` (a timeline).
const pool = require('./db/pool');

// Vocabulário de status/estágio → rótulo em português pra descrição da timeline.
const STATUS_LABEL = {
  opened: 'aberta', analysis: 'em análise', closed: 'encerrada',
  resolved: 'resolvida', rejected: 'rejeitada', cancelled: 'cancelada',
  archived: 'arquivada', in_mediation: 'em mediação',
};
const STAGE_LABEL = {
  claim: 'reclamação', dispute: 'disputa (mediação)', recontact: 'recontato',
  stale: 'parada', none: 'sem estágio',
};

// Extrai do JSON cru da claim os campos que representam o estado atual.
function claimFields(claim) {
  const players = Array.isArray(claim.players) ? claim.players : [];
  const mediator = players.find(p => p.role === 'mediator');
  return {
    claimId: claim.id != null ? String(claim.id) : null,
    status: claim.status || null,
    substatus: claim.status_detail || claim.substatus || null,
    stage: claim.stage || null,
    resolution: claim.resolution?.reason || claim.resolution?.description || null,
    reason: claim.reason_id || null,
    mediador: mediator?.user_id != null ? String(mediator.user_id) : null,
    date: claim.date_created || null,
    title: claim.resolution?.description || claim.reason_id || null,
  };
}

// Texto legível de uma transição, pra timeline ("Reclamação encerrada", etc.).
function describeTransition(prev, cur) {
  if (cur.stage && prev && prev.stage !== cur.stage && cur.stage === 'dispute') {
    return 'Mediação iniciada';
  }
  const s = STATUS_LABEL[cur.status] || cur.status || 'atualizada';
  if (['closed', 'resolved', 'rejected', 'cancelled', 'archived'].includes(cur.status)) {
    return `Reclamação ${s}`;
  }
  if (cur.status === 'in_mediation' || cur.stage === 'dispute') return 'Reclamação em mediação';
  return `Status alterado para "${s}"`;
}

// Grava um evento no histórico — só quando há transição real de estado, pra o
// histórico não crescer a cada poll idêntico (a `returns` já guarda o estado
// atual). Retorna true se inseriu.
async function recordClaimEvent(claimId, { event_type, status, substatus, description, payload }) {
  if (!claimId) return false;
  await pool.query(
    `INSERT INTO claim_history (claim_id, event_type, status, substatus, description, payload_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [claimId, event_type || null, status || null, substatus || null, description || null,
     payload ? JSON.stringify(payload) : null]
  );
  return true;
}

// Upsert idempotente de uma claim. Preserva os campos MANUAIS (prejuizo, note,
// abertura_chamado) — eles não estão na lista de colunas do UPDATE, então o
// ON CONFLICT não os toca. `amount` só sobrescreve se vier > 0 (não zera um
// valor bom quando o pedido ainda não foi importado).
//
// Params: { storeId, orderId, buyerNickname, amount, claim }
// Retorna: { id, claimId, isNew, previousStatus, statusChanged }
async function upsertClaim({ storeId, orderId, buyerNickname, amount, claim }) {
  const f = claimFields(claim);
  if (!f.claimId) return { id: null, claimId: null, isNew: false, previousStatus: null, statusChanged: false };

  // Estado anterior (pra detectar transição e alimentar o histórico).
  const { rows: prevRows } = await pool.query(
    `SELECT status, raw_data->>'stage' AS stage, raw_data->>'status_detail' AS substatus
       FROM returns WHERE claim_id = $1`, [f.claimId]
  );
  const prev = prevRows[0] || null;

  const { rows: up } = await pool.query(
    `INSERT INTO returns (store_id, order_id, buyer_nickname, title, reason, amount, status, date, claim_id, raw_data, last_synced_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
     ON CONFLICT (claim_id) WHERE claim_id IS NOT NULL DO UPDATE SET
       store_id       = EXCLUDED.store_id,
       order_id       = COALESCE(EXCLUDED.order_id, returns.order_id),
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, returns.buyer_nickname),
       title          = COALESCE(EXCLUDED.title, returns.title),
       reason         = COALESCE(EXCLUDED.reason, returns.reason),
       amount         = COALESCE(NULLIF(EXCLUDED.amount, 0), returns.amount),
       status         = EXCLUDED.status,
       date           = COALESCE(EXCLUDED.date, returns.date),
       raw_data       = EXCLUDED.raw_data,
       last_synced_at = now(),
       updated_at     = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [storeId, orderId, buyerNickname, f.title, f.reason, Number(amount) || 0,
     f.status, f.date, f.claimId, JSON.stringify(claim)]
  );
  const id = up[0].id;
  const isNew = up[0].inserted === true;

  // Histórico: "criada" na 1ª vez; "transição" quando status/stage/substatus mudam.
  const statusChanged = !prev
    || prev.status !== f.status
    || (prev.stage || null) !== (f.stage || null)
    || (prev.substatus || null) !== (f.substatus || null);

  if (isNew) {
    await recordClaimEvent(f.claimId, {
      event_type: 'created', status: f.status, substatus: f.substatus,
      description: 'Reclamação criada', payload: claim,
    });
  } else if (statusChanged) {
    await recordClaimEvent(f.claimId, {
      event_type: (prev && (prev.stage || null) !== (f.stage || null)) ? 'stage_change' : 'status_change',
      status: f.status, substatus: f.substatus,
      description: describeTransition(prev, f), payload: claim,
    });
  }

  return { id, claimId: f.claimId, isNew, previousStatus: prev?.status || null, statusChanged };
}

module.exports = { upsertClaim, recordClaimEvent, claimFields, STATUS_LABEL, STAGE_LABEL };
