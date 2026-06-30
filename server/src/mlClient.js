// Mercado Livre API client — used ONLY by workers, never exposed to the frontend.
// Each webhook tells us a single resource changed; we fetch just that resource.
const fetch = require('node-fetch');
const pool = require('./db/pool');

const BASE = 'https://api.mercadolibre.com';

async function getAccessToken(storeId) {
  const { rows } = await pool.query('SELECT access_token FROM stores WHERE id = $1', [storeId]);
  if (!rows.length) throw new Error(`store ${storeId} not found`);
  return rows[0].access_token;
}

async function get(path, storeId) {
  const token = await getAccessToken(storeId);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ML API ${path} -> HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  getItem: (id, storeId) => get(`/items/${id}`, storeId),
  getOrder: (id, storeId) => get(`/orders/${id}`, storeId),
  getQuestion: (id, storeId) => get(`/questions/${id}`, storeId),
  getMessagesPack: (packId, storeId) => get(`/messages/packs/${packId}/sellers/me`, storeId),
  getSellerReputation: (storeId) => get(`/users/${storeId}/seller_reputation`, storeId),
};
