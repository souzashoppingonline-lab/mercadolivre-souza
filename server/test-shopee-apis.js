// Diagnóstico READ-ONLY dos 3 endpoints Shopee que vamos usar em seguida,
// TODOS numa rodada só (não escreve nada). Confirma o formato real antes de
// codar parser/schema — mesma disciplina do test-shopee-tracking.js.
//
//   1) payment/get_escrow_detail   → repasse/taxas por pedido (financeiro)
//   2) logistics/get_tracking_info → status de entrega + eventos de rastreio
//   3) sellerchat/get_conversation_list → conversas de chat (não respondidas)
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-apis.js
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
    access_token: accessToken, shop_id: String(shopId),
    ...extra,
  });
  const res = await fetch(`${BASE}${apiPath}?${qs}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function show(label, r) {
  console.log(`\n──── ${label} [${r.status}] ────`);
  const s = JSON.stringify(r.body, null, 2);
  console.log(s.length > 2500 ? s.slice(0, 2500) + '\n… (truncado)' : s);
}

(async () => {
  console.log(`\n== Shopee APIs (${ENV}) ==`);
  if (!PARTNER_ID || !PARTNER_KEY) { console.log('  ❌ credenciais ausentes'); return pool.end(); }

  const { rows: st } = await pool.query(
    `SELECT s.id, s.nickname, s.shopee_shop_id, s.access_token
       FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  ❌ nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token, nickname } = st[0];
  console.log(`  loja: ${nickname} (shop_id=${shopId})`);

  const { rows: ord } = await pool.query(
    `SELECT o.ml_id AS order_sn FROM orders o JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE m.code = 'SHOPEE' AND o.store_id = $1 ORDER BY o.date_created DESC LIMIT 1`, [st[0].id]);
  const orderSn = ord[0]?.order_sn;
  console.log(`  pedido de teste: ${orderSn || '(nenhum)'}`);

  try {
    if (orderSn) {
      show('1) get_escrow_detail (financeiro/repasse)', await call('/api/v2/payment/get_escrow_detail', token, shopId, { order_sn: orderSn }));
      show('2) get_tracking_info (status de entrega)', await call('/api/v2/logistics/get_tracking_info', token, shopId, { order_sn: orderSn }));
    }
    show('3) get_conversation_list (chat)', await call('/api/v2/sellerchat/get_conversation_list', token, shopId, { type: 'all', page_size: '10' }));
  } catch (e) {
    console.log('  erro:', e.message);
  }
  console.log('\n  Cole a saída aqui — com esses formatos eu monto escrow, entrega e chat (cada um isolado na Shopee).\n');
  await pool.end();
})();
