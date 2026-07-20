// Diagnóstico READ-ONLY: a etiqueta Shopee bipada traz o TRACKING NUMBER
// (ex.: BR269090120689K), não o order_sn. Pra casar rastreio→pedido na
// Embalagem, precisamos do get_tracking_number da Logistics API da Shopee.
//
// Este script confirma que, para pedidos que JÁ estão no nosso banco
// (marketplace_id=SHOPEE), o get_tracking_number devolve o mesmo BR...K que
// está impresso na etiqueta. Se bater, o módulo Embalagem Shopee é viável
// casando por tracking_number.
//
// Só faz GET (não escreve nada). Roda em produção:
//   cd /opt/ml-dashboard-novo/server && node test-shopee-tracking.js
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

async function getTracking(accessToken, shopId, orderSn) {
  const apiPath = '/api/v2/logistics/get_tracking_number';
  const ts = nowSec();
  const qs = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(ts),
    sign: sign(apiPath, ts, accessToken, shopId),
    access_token: accessToken,
    shop_id: String(shopId),
    order_sn: orderSn,
  });
  const res = await fetch(`${BASE}${apiPath}?${qs}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  console.log(`\n== Shopee get_tracking_number (${ENV} — ${BASE}) ==`);
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.log('  ❌ SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY ausentes no .env'); return pool.end();
  }

  // Pega a 1ª conta Shopee conectada
  const { rows: stores } = await pool.query(
    `SELECT s.id, s.nickname, s.shopee_shop_id, s.access_token
       FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL
      ORDER BY s.id LIMIT 1`
  );
  if (!stores.length) { console.log('  ❌ nenhuma conta Shopee com access_token'); return pool.end(); }
  const st = stores[0];
  console.log(`  loja: ${st.nickname} (shop_id=${st.shopee_shop_id})`);

  // Pega até 8 pedidos Shopee recentes do banco
  const { rows: orders } = await pool.query(
    `SELECT o.ml_id AS order_sn
       FROM orders o JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE m.code = 'SHOPEE' AND o.store_id = $1
      ORDER BY o.date_created DESC LIMIT 8`,
    [st.id]
  );
  console.log(`  ${orders.length} pedido(s) no banco pra testar\n`);

  for (const o of orders) {
    try {
      const { status, body } = await getTracking(st.access_token, st.shopee_shop_id, o.order_sn);
      const tn = body?.response?.tracking_number;
      if (tn) {
        console.log(`  ✅ ${o.order_sn}  →  tracking: ${tn}`);
      } else {
        console.log(`  ⚠️  ${o.order_sn}  →  [${status}] ${body.error || ''} ${body.message || ''}`.trim());
      }
    } catch (e) {
      console.log(`  ❌ ${o.order_sn}  →  ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // gentil com o rate limit
  }

  console.log('\n  Compare os "tracking" acima com o BR...K impresso nas etiquetas.');
  console.log('  Se baterem, casar etiqueta→pedido por tracking_number é viável.\n');
  await pool.end();
})();
