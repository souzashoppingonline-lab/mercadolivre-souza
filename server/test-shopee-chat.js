// Diagnóstico READ-ONLY do chat Shopee (get_conversation_list). O 1º teste deu
// param_error (491) — a API exige combinação certa de params (type/direction/
// page_size/next_timestamp_nano). Este script testa VÁRIAS combinações e mostra
// qual retorna 200, pra a gente montar a notificação de mensagens não respondidas.
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-chat.js
require('dotenv').config();
const crypto = require('crypto');
const fetch = require('node-fetch');
const pool = require('./src/db/pool');

const PARTNER_ID = process.env.SHOPEE_PARTNER_ID;
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const ENV = process.env.SHOPEE_ENV === 'production' ? 'production' : 'sandbox';
const BASE = ENV === 'production' ? 'https://partner.shopeemobile.com' : 'https://partner.uat.shopeemobile.com';
const nowSec = () => Math.floor(Date.now() / 1000);

function sign(apiPath, ts, accessToken, shopId) {
  let base = `${PARTNER_ID}${apiPath}${ts}`;
  if (accessToken && shopId) base += `${accessToken}${shopId}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(base).digest('hex');
}

async function call(apiPath, accessToken, shopId, extra = {}) {
  const ts = nowSec();
  const qs = new URLSearchParams({
    partner_id: PARTNER_ID, timestamp: String(ts),
    sign: sign(apiPath, ts, accessToken, shopId),
    access_token: accessToken, shop_id: String(shopId), ...extra,
  });
  const res = await fetch(`${BASE}${apiPath}?${qs}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  console.log(`\n== Shopee chat — get_conversation_list (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  const P = '/api/v2/sellerchat/get_conversation_list';
  // Combinações candidatas (a doc da Shopee varia; testamos as mais prováveis).
  const tentativas = [
    { type: 'all', direction: 'latest', page_size: '25' },
    { type: 'all', direction: 'latest', page_size: '25', next_timestamp_nano: '0' },
    { type: 'unread', direction: 'latest', page_size: '25' },
    { direction: 'latest', page_size: '25' },
    { type: 'all', page_size: '25' },
    { type: 'all', direction: 'older', page_size: '25' },
  ];

  for (const t of tentativas) {
    const r = await call(P, token, shopId, t);
    const ok = r.status === 200 && !r.body.error;
    const tag = ok ? '✅' : '❌';
    console.log(`\n${tag} params=${JSON.stringify(t)}  [${r.status}] ${r.body.error || ''} ${r.body.message || ''}`.trim());
    if (ok) {
      const s = JSON.stringify(r.body.response, null, 2);
      console.log(s.length > 1800 ? s.slice(0, 1800) + '\n… (truncado)' : s);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log('\n  A combinação com ✅ é a que vamos usar. Cole a saída aqui.\n');
  await pool.end();
})();
