// Diagnóstico READ-ONLY das devoluções/reembolsos Shopee (Returns API).
// Confirma se o app tem acesso e o formato dos campos (status, refund_amount,
// reason) antes de plugar no Painel de Problemas. Só GET, não altera nada.
//   cd /opt/ml-dashboard-novo/server && node test-shopee-returns.js
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
async function callGet(apiPath, token, shopId, extra = {}) {
  const ts = nowSec();
  const qs = new URLSearchParams({
    partner_id: PARTNER_ID, timestamp: String(ts), sign: sign(apiPath, ts, token, shopId),
    access_token: token, shop_id: String(shopId), ...extra,
  });
  const res = await fetch(`${BASE}${apiPath}?${qs}`, { method: 'GET' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function dump(label, r, max = 2200) {
  const ok = r.status === 200 && !r.body.error;
  console.log(`\n${ok ? '✅' : '❌'} ${label} [${r.status}] ${r.body.error || ''} ${r.body.message || ''}`.trim());
  if (ok) { const s = JSON.stringify(r.body.response, null, 2); console.log(s && s.length > max ? s.slice(0, max) + '\n… (truncado)' : s); }
}

(async () => {
  console.log(`\n== Shopee Returns API — diagnóstico (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  // get_return_list — janela de 60 dias (algumas versões exigem create_time).
  dump('returns/get_return_list (60d)', await callGet('/api/v2/returns/get_return_list', token, shopId, {
    page_no: '1', page_size: '20', create_time_from: String(nowSec() - 60 * 24 * 3600), create_time_to: String(nowSec()),
  }));
  await new Promise(r => setTimeout(r, 400));
  // sem janela (fallback)
  dump('returns/get_return_list (sem janela)', await callGet('/api/v2/returns/get_return_list', token, shopId, {
    page_no: '1', page_size: '20',
  }));

  console.log('\n  ✅ = liberado. Confirme os campos: return_sn, order_sn, status, reason, refund_amount, create_time. Cole a saída aqui.\n');
  await pool.end();
})();
