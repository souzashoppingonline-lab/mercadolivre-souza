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
  const token = await getAccessToken(storeId);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 429 — throw immediately so BullMQ's exponential backoff handles the delay.
  // Internal retry would silently block the queue slot for 30 s+ and still fail.
  if (res.status === 429) {
    throw new Error(`ML API ${path} -> HTTP 429 (rate limited)`);
  }

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
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ML API POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  get,
  post,
  getItem:             (id, storeId)     => get(`/items/${id}`, storeId),
  getOrder:            (id, storeId)     => get(`/orders/${id}`, storeId),
  getPayment:          (id, storeId)     => get(`/collections/${id}`, storeId),
  getQuestion:         (id, storeId)     => get(`/questions/${id}`, storeId),
  answerQuestion:      (questionId, text, storeId) => post('/answers', storeId, { question_id: questionId, text }),
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
