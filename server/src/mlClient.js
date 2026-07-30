// Mercado Livre API client — used ONLY by workers, never exposed to the frontend.
// Each webhook tells us a single resource changed; we fetch just that resource.
// Tokens are refreshed automatically when within 5 minutes of expiry.
const fetch = require('node-fetch');
const pool = require('./db/pool');

const BASE = 'https://api.mercadolibre.com';

// Per-store mutex: prevents concurrent token refreshes that trigger ML 429
const refreshLocks = new Map();
// Per-store OAuth cooldown: after a 429 on token refresh, block further attempts for 35 min
const oauthCooldown = new Map(); // storeId → unix ms when cooldown expires

// ── Throttle por-APP (por loja) ───────────────────────────────────────────
// O rate limit do ML é por-APP. Na produção atual CADA loja tem seu próprio
// app (`stores.ml_client_id` preenchido — confirmado no banco), logo cada uma
// tem um orçamento independente (~3000/min cada). Portanto o bucket é POR LOJA,
// não global: estrangular as três num teto único faria uma loja saudável
// esperar pela cota da loja saturada. Cada loja ganha seu próprio token-bucket,
// dimensionado abaixo do teto do app com folga para picos. Lojas que caírem no
// app global do `.env` (sem client_id próprio) recebem, cada uma, seu bucket —
// levemente permissivo, mas o circuit breaker abaixo cobre o 429 nesse caso.
// Valores ajustáveis por env sem redeploy.
const RL_CAP  = Number(process.env.ML_RL_BURST || 30); // tokens de pico (burst) por loja
const RL_RATE = Number(process.env.ML_RL_RATE || 20);  // req/s sustentado por loja (~1200/min)
const rlBuckets = new Map(); // storeId → { tokens, last }

function _rlBucket(storeId) {
  let b = rlBuckets.get(storeId);
  if (!b) { b = { tokens: RL_CAP, last: Date.now() }; rlBuckets.set(storeId, b); }
  const now = Date.now();
  const elapsed = (now - b.last) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(RL_CAP, b.tokens + elapsed * RL_RATE);
    b.last = now;
  }
  return b;
}

// Espera cooperativa (Node single-thread → sem lock) até haver 1 token no
// bucket DESTA loja. Não bloqueia as outras lojas.
async function acquireToken(storeId) {
  for (;;) {
    const b = _rlBucket(storeId);
    if (b.tokens >= 1) { b.tokens -= 1; return; }
    const waitMs = Math.ceil(((1 - b.tokens) / RL_RATE) * 1000);
    await new Promise(r => setTimeout(r, Math.max(15, waitMs)));
  }
}

// Ao receber 429, drena o bucket DESTA loja para ela recuar por ~`seconds` —
// não afeta o ritmo das outras (apps independentes).
function rlPenalize(storeId, seconds = 2) {
  const b = _rlBucket(storeId);
  b.tokens = Math.min(b.tokens, -RL_RATE * seconds);
}

// ── Circuit breaker por loja (429 do lado do ML) ──────────────────────────
// Quando o ML penaliza o app de UMA loja, ele devolve 429 pra praticamente
// tudo daquela loja por um tempo — e os 5 retries do BullMQ (por tópico!)
// continuam batendo, mantendo a penalidade viva. Este gate, por-loja e por
// cima de todos os tópicos, para de mandar as chamadas daquela loja por uma
// janela crescente (5s→60s) assim que ela leva 429, deixando o ML recuperar.
// As outras lojas seguem normais. Reseta no 1º sucesso. Mesmo racional do
// circuit breaker de `syncShippingStatus` (ver decisions.md), agora na base.
const storeCooldown = new Map(); // storeId → unix ms até quando pular chamadas
const store429Streak = new Map(); // storeId → nº de 429 seguidos (backoff)

function noteStore429(storeId) {
  const streak = (store429Streak.get(storeId) || 0) + 1;
  store429Streak.set(storeId, streak);
  const secs = Math.min(60, 5 * Math.pow(2, streak - 1)); // 5,10,20,40,60(teto)
  storeCooldown.set(storeId, Date.now() + secs * 1000);
  if (streak === 1) {
    console.warn(`[mlClient] 🧊 breaker aberto — store ${storeId} (429) — segurando chamadas`);
  }
}
function noteStoreOk(storeId) {
  // Só desarma num sucesso "limpo" — fora de uma janela de cooldown ativa.
  // Um 200 de endpoint barato (invoices/stock-locations) no meio de uma
  // rajada de 429 NÃO pode zerar o breaker, senão ele nunca segura: o cooldown
  // era limpo em milissegundos por qualquer sucesso interleaved (bug real
  // observado em produção — invoices da loja retornavam 200 entre os 429).
  if (store429Streak.has(storeId) && Date.now() >= (storeCooldown.get(storeId) || 0)) {
    store429Streak.delete(storeId);
    storeCooldown.delete(storeId);
    console.warn(`[mlClient] ✅ breaker fechado — store ${storeId} recuperou`);
  }
}
function storeInCooldown(storeId) {
  return Date.now() < (storeCooldown.get(storeId) || 0);
}

async function getAccessToken(storeId) {
  const { rows } = await pool.query(
    'SELECT access_token, token_expires_at FROM stores WHERE id = $1', [storeId]
  );
  if (!rows.length) throw new Error(`store ${storeId} not found — authorize via /auth/login`);

  const { access_token, token_expires_at } = rows[0];
  const expiresIn = token_expires_at ? (new Date(token_expires_at) - Date.now()) : 0;

  if (expiresIn >= 5 * 60 * 1000) return access_token;

  // Token expirado ou quase: cooldown só bloqueia se ainda há tempo de sobra
  // Se o token já expirou, ignora o cooldown e tenta renovar de qualquer forma
  const coolUntil = oauthCooldown.get(storeId) || 0;
  if (Date.now() < coolUntil && expiresIn > 0) {
    const mins = Math.ceil((coolUntil - Date.now()) / 60000);
    throw new Error(`OAUTH_RATE_LIMITED: store ${storeId} em cooldown por mais ${mins} min`);
  }

  // Deduplicate concurrent refreshes: if one is already in-flight, wait for it
  if (refreshLocks.has(storeId)) {
    return refreshLocks.get(storeId);
  }

  const { refreshToken } = require('./routes/auth');
  const promise = refreshToken(storeId)
    .catch(err => {
      if (err.oauthRateLimit) {
        // Block further refresh attempts for 5 min — suficiente para ML resetar o rate limit
        // 35 min era muito agressivo e bloqueava processamento de webhooks válidos
        oauthCooldown.set(storeId, Date.now() + 5 * 60 * 1000);
        console.warn(`[mlClient] OAuth 429 store=${storeId} — cooldown 5 min`);
      }
      throw err;
    })
    .finally(() => refreshLocks.delete(storeId));
  refreshLocks.set(storeId, promise);
  return promise;
}

async function get(path, storeId, retries = 1) {
  // Circuit breaker por loja: se o ML já está penalizando esta loja (429 recente),
  // nem tenta — falha na hora sem tocar no ML nem renovar token, deixando o app
  // dela esfriar. O backoff do BullMQ reagenda; ML para de ver o flood e recupera.
  if (storeInCooldown(storeId)) {
    throw new Error(`ML API ${path} -> store ${storeId} em cooldown de rate limit (429 recente)`);
  }
  const token = await getAccessToken(storeId);
  await acquireToken(storeId); // throttle do app DESTA loja (não bloqueia as outras)
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 429 — throw immediately so BullMQ's exponential backoff handles the delay.
  // Internal retry would silently block the queue slot for 30 s+ and still fail.
  if (res.status === 429) {
    noteStore429(storeId); // abre/estende o cooldown desta loja (5s→60s)
    rlPenalize(storeId); // recua o app DESTA loja por ~2s
    throw new Error(`ML API ${path} -> HTTP 429 (rate limited)`);
  }

  if (res.ok) noteStoreOk(storeId); // 1º sucesso zera o streak/cooldown da loja

  // 5xx transient error — one quick retry after 2 s, then propagate.
  if (res.status >= 500 && retries > 0) {
    await new Promise(r => setTimeout(r, 2000));
    return get(path, storeId, retries - 1);
  }

  // Corpo do erro incluído na mensagem (mesmo padrão do post() logo abaixo) —
  // sem isso, um 400 de parâmetro inválido só mostra o código, não o motivo
  // que o ML devolveu (ex: qual query param é inválido).
  if (!res.ok) throw new Error(`ML API ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function post(path, storeId, body) {
  const token = await getAccessToken(storeId);
  await acquireToken(storeId); // throttle do app desta loja
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) rlPenalize(storeId);
  if (!res.ok) throw new Error(`ML API POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function del(path, storeId) {
  const token = await getAccessToken(storeId);
  await acquireToken(storeId);
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) rlPenalize(storeId);
  if (!res.ok) throw new Error(`ML API DELETE ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.text().then((t) => { try { return JSON.parse(t); } catch (_) { return { ok: true }; } });
}

// ── Mercado Pago (api.mercadopago.com) — mesmo token OAuth do ML autentica
// aqui (confirmado ao vivo, ver decisions.md). Usado só pelos Relatórios de
// Conciliação. `mpDownload` devolve Buffer (o arquivo é XLSX binário).
const MP_BASE = 'https://api.mercadopago.com';
async function mpGet(path, storeId) {
  const token = await getAccessToken(storeId);
  const res = await fetch(`${MP_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new Error(`MP API ${path} -> HTTP 429 (rate limited)`);
  if (!res.ok) throw new Error(`MP API ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function mpDownload(path, storeId) {
  const token = await getAccessToken(storeId);
  const res = await fetch(`${MP_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`MP download ${path} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function mpPost(path, storeId, body) {
  const token = await getAccessToken(storeId);
  const res = await fetch(`${MP_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 202 = aceito (relatório gerando async); o corpo pode vir vazio
  if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
    throw new Error(`MP POST ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return { status: res.status };
}

module.exports = {
  get,
  post,
  // Relatórios de Conciliação MP — type ∈ 'release_report' | 'settlement_report'
  getMpReportList:  (type, storeId)            => mpGet(`/v1/account/${type}/list`, storeId),
  downloadMpReport: (type, fileName, storeId)  => mpDownload(`/v1/account/${type}/${fileName}`, storeId),
  // begin_date/end_date vão no CORPO JSON, formato datetime ISO **sem
  // milissegundos** (confirmado ao vivo via test-mp-create.js: com `.000Z` ou
  // só a data devolve 400 "Must specify begin_date"; `2026-06-18T22:44:49Z`
  // no body → 202). mpReports.js já manda com .slice(0,19)+'Z'.
  createMpReport:   (type, storeId, begin, end) => mpPost(`/v1/account/${type}`, storeId, { begin_date: begin, end_date: end }),
  getItem:             (id, storeId)     => get(`/items/${id}`, storeId),
  getOrder:            (id, storeId)     => get(`/orders/${id}`, storeId),
  getPayment:          (id, storeId)     => get(`/collections/${id}`, storeId),
  getQuestion:         (id, storeId)     => get(`/questions/${id}`, storeId),
  answerQuestion:      (questionId, text, storeId) => post('/answers', storeId, { question_id: questionId, text }),
  deleteQuestion:      (questionId, storeId) => del(`/questions/${questionId}`, storeId),
  getMessage:          (msgId, storeId)  => get(`/messages/${msgId}?tag=post_sale&seller_id=${storeId}`, storeId),
  getMessagesPack:     (packId, storeId) => get(`/messages/packs/${packId}?tag=post_sale&seller_id=${storeId}`, storeId),
  getSellerReputation: (storeId)         => get(`/users/${storeId}/seller_reputation`, storeId),
  getShipment:         (shipmentId, storeId) => get(`/shipments/${shipmentId}`, storeId),
  // Endpoint correto tem o segmento /v1/ — a API antiga sem versão (/post-purchase/claims/...)
  // foi descontinuada pelo ML em 2024 e devolve 404 (confirmado em produção — ver decisions.md).
  // Nomes de filtro exatos confirmados testando direto contra a API real
  // (a doc pública sugeria "players.role"/"players.user_id", que devolve 400
  // — o correto, confirmado pela própria mensagem de erro do ML, é
  // player_role + player_user_id, singular e com underscore):
  // player_role=respondent + player_user_id=storeId filtra claims onde o
  // vendedor é quem precisa responder (o caso de uso desta tela).
  searchClaims:        (storeId, offset=0) => get(`/post-purchase/v1/claims/search?player_role=respondent&player_user_id=${storeId}&limit=50&offset=${offset}`, storeId),
  getClaim:            (claimId, storeId) => get(`/post-purchase/v1/claims/${claimId}`, storeId),
  // Traduz um reason_id (ex: "PNR9509") pra descrição legível em português
  // ("Me arrependi da compra") — testado ao vivo, campo `detail` já vem
  // traduzido. Chamado só quando o código ainda não está cacheado em
  // claim_reasons (ver worker.js resolveClaimReason) pra não estourar rate
  // limit reprocessando o mesmo código toda vez.
  getClaimReason:      (reasonId, storeId) => get(`/marketplace/v2/claims/reasons/${reasonId}`, storeId),
  getOffer:            (offerId, storeId) => get(`/seller-promotions/offers/${offerId}?app_version=v2`, storeId),
  searchOrders:        (storeId, dateFrom, offset=0) => get(`/orders/search?seller=${storeId}&sort=date_desc&order.date_created.from=${encodeURIComponent(dateFrom)}&limit=50&offset=${offset}`, storeId),
  getItemVisits:       (id, dateFrom, storeId) => get(`/items/${id}/visits/time_window?last=1&unit=day&ending=${encodeURIComponent(dateFrom)}`, storeId),
  // Qualidade de Anúncio (SEO Score) — ver seoScore.js e .claude/decisions.md.
  getItemDescription:  (id, storeId) => get(`/items/${id}/description`, storeId),
  getCategoryAttributes: (categoryId, storeId) => get(`/categories/${categoryId}/attributes`, storeId),
  // Monitor de Buy-Box (catálogo) — ver .claude/decisions.md. GET /sites/MLB/search
  // (busca livre) devolve 403 "forbidden" pra este app (confirmado ao vivo, não é rate
  // limit); estes dois endpoints são diferentes (dado do próprio vendedor participando
  // de catálogo, não busca pública) e foram confirmados acessíveis ao vivo.
  getPriceToWin:       (id, storeId) => get(`/items/${id}/price_to_win?version=v2`, storeId),
  getCatalogCompetitors: (catalogProductId, storeId) => get(`/products/${catalogProductId}/items`, storeId),
  // Conciliação Bancária — API de Faturamento (Relatórios de Faturamento).
  // group: 'ML' | 'MP'. document_type é obrigatório em /monthly/periods
  // (confirmado ao vivo: 422 MISSING_PARAMETER_ERROR sem ele) — só 'BILL'
  // (fatura) interessa aqui, 'CREDIT_NOTE' não é usado. Ver .claude/decisions.md.
  getBillingPeriods:   (group, storeId, limit = 12) => get(`/billing/integration/monthly/periods?group=${group}&document_type=BILL&limit=${limit}`, storeId),
  getBillingDetails:   (periodKey, group, storeId, { lastId = 0, limit = 150 } = {}) =>
    get(`/billing/integration/periods/key/${periodKey}/group/${group}/details?document_type=BILL&limit=${limit}${lastId ? `&last_id=${lastId}` : ''}`, storeId),
};
