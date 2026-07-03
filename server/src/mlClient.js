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
        // Block further refresh attempts for 35 min
        oauthCooldown.set(storeId, Date.now() + 35 * 60 * 1000);
        console.warn(`[mlClient] OAuth 429 store=${storeId} — cooldown 35 min`);
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

  if (!res.ok) throw new Error(`ML API ${path} -> HTTP ${res.status}`);
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
  getQuestion:         (id, storeId)     => get(`/questions/${id}`, storeId),
  answerQuestion:      (questionId, text, storeId) => post('/answers', storeId, { question_id: questionId, text }),
  getMessagesPack:     (packId, storeId) => get(`/messages/packs/${packId}/sellers/${storeId}`, storeId),
  getSellerReputation: (storeId)         => get(`/users/${storeId}/seller_reputation`, storeId),
  getShipment:         (shipmentId, storeId) => get(`/shipments/${shipmentId}`, storeId),
  searchClaims:        (storeId, offset=0) => get(`/post-purchase/claims/search?seller_id=${storeId}&limit=50&offset=${offset}`, storeId),
  getClaim:            (claimId, storeId) => get(`/post-purchase/claims/${claimId}`, storeId),
  getOffer:            (offerId, storeId) => get(`/seller-promotions/offers/${offerId}?app_version=v2`, storeId),
  searchOrders:        (storeId, dateFrom) => get(`/orders/search?seller=${storeId}&sort=date_desc&order.date_created.from=${encodeURIComponent(dateFrom)}&limit=50`, storeId),
  getItemVisits:       (id, dateFrom, storeId) => get(`/items/${id}/visits/time_window?last=1&unit=day&ending=${encodeURIComponent(dateFrom)}`, storeId),
};
