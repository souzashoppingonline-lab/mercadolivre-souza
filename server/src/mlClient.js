// Mercado Livre API client — used ONLY by workers, never exposed to the frontend.
// Each webhook tells us a single resource changed; we fetch just that resource.
// Tokens are refreshed automatically when within 5 minutes of expiry.
const fetch = require('node-fetch');
const pool = require('./db/pool');

const BASE = 'https://api.mercadolibre.com';

async function getAccessToken(storeId) {
  const { rows } = await pool.query(
    'SELECT access_token, token_expires_at FROM stores WHERE id = $1', [storeId]
  );
  if (!rows.length) throw new Error(`store ${storeId} not found — authorize via /auth/login`);

  const { access_token, token_expires_at } = rows[0];
  const expiresIn = token_expires_at ? (new Date(token_expires_at) - Date.now()) : 0;

  // Refresh proactively if token expires in less than 5 minutes
  if (expiresIn < 5 * 60 * 1000) {
    const { refreshToken } = require('./routes/auth');
    return refreshToken(storeId);
  }

  return access_token;
}

async function get(path, storeId, retries = 3) {
  const token = await getAccessToken(storeId);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const delay = (4 - retries) * 5000; // 5s, 10s, 15s
    await new Promise(r => setTimeout(r, delay));
    return get(path, storeId, retries - 1);
  }
  if (!res.ok) throw new Error(`ML API ${path} -> HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  get,
  getItem:             (id, storeId)     => get(`/items/${id}`, storeId),
  getOrder:            (id, storeId)     => get(`/orders/${id}`, storeId),
  getQuestion:         (id, storeId)     => get(`/questions/${id}`, storeId),
  getMessagesPack:     (packId, storeId) => get(`/messages/packs/${packId}/sellers/me`, storeId),
  getSellerReputation: (storeId)         => get(`/users/${storeId}/seller_reputation`, storeId),
  getOffer:            (offerId, storeId) => get(`/seller-promotions/offers/${offerId}?app_version=v2`, storeId),
  searchOrders:        (storeId, dateFrom) => get(`/orders/search?seller=${storeId}&sort=date_desc&order.date_created.from=${encodeURIComponent(dateFrom)}&limit=50`, storeId),
  getItemVisits:       (ids, dateFrom, storeId) => get(`/items/visits?ids=${ids.join(',')}&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(new Date().toISOString().slice(0,10))}`, storeId),
};
