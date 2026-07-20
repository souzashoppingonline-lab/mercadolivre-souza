// Diagnóstico READ-ONLY do histórico de mensagens Shopee (get_message_list).
// Pega a 1ª conversa do get_conversation_list e lista as mensagens dela, pra
// confirmar os nomes reais dos campos (message_id/from_id/to_id/content.text/
// created_timestamp) antes de confiar na renderização do chat. NÃO envia nada.
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-chat-msg.js
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
  console.log(`\n== Shopee chat — get_message_list (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  // 1) pega uma conversa qualquer
  const conv = await call('/api/v2/sellerchat/get_conversation_list', token, shopId, { type: 'all', direction: 'latest', page_size: '5' });
  const list = conv.body?.response?.conversations || [];
  console.log(`\nconversas encontradas: ${list.length}`);
  if (!list.length) { console.log('  (sem conversas — nada pra testar)'); return pool.end(); }
  const c = list[0];
  console.log(`\nusando conversation_id=${c.conversation_id} to_id=${c.to_id} to_name=${c.to_name}`);

  // 2) histórico dela
  const r = await call('/api/v2/sellerchat/get_message_list', token, shopId, {
    conversation_id: String(c.conversation_id), page_size: '10',
  });
  const ok = r.status === 200 && !r.body.error;
  console.log(`\n${ok ? '✅' : '❌'} get_message_list [${r.status}] ${r.body.error || ''} ${r.body.message || ''}`.trim());
  const s = JSON.stringify(r.body.response, null, 2);
  console.log(s && s.length > 2500 ? s.slice(0, 2500) + '\n… (truncado)' : s);
  console.log('\n  Confirme os campos: message_id / from_id / to_id / content.text / message_type / created_timestamp. Cole a saída aqui.\n');
  await pool.end();
})();
