// Diagnóstico READ-ONLY das promoções Shopee — confirma o que o app tem acesso
// e o formato dos PRAZOS (start_time/end_time/status) antes de codar a página
// Promoções. Só GET, não cria/altera nada. Testa:
//   1) discount/get_discount_list   — promoções de desconto (prazo + status)
//   2) voucher/get_voucher_list     — cupons/vouchers (prazo + uso)
//   3) shop_flash_sale/get_shop_flash_sale_list — flash sale da loja
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-promo.js
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

function dump(label, r, max = 1800) {
  const ok = r.status === 200 && !r.body.error;
  console.log(`\n${ok ? '✅' : '❌'} ${label} [${r.status}] ${r.body.error || ''} ${r.body.message || ''}`.trim());
  if (ok) {
    const s = JSON.stringify(r.body.response, null, 2);
    console.log(s && s.length > max ? s.slice(0, max) + '\n… (truncado)' : s);
  }
}

(async () => {
  console.log(`\n== Shopee Promoções — diagnóstico (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  // 1) Descontos — status: upcoming | ongoing | expired | all
  dump('discount/get_discount_list (ongoing)', await callGet('/api/v2/discount/get_discount_list', token, shopId, { discount_status: 'ongoing', page_no: '1', page_size: '20' }));
  await new Promise(r => setTimeout(r, 400));
  dump('discount/get_discount_list (upcoming)', await callGet('/api/v2/discount/get_discount_list', token, shopId, { discount_status: 'upcoming', page_no: '1', page_size: '20' }));
  await new Promise(r => setTimeout(r, 400));

  // 2) Vouchers — status: upcoming | ongoing | expired | all
  dump('voucher/get_voucher_list (all)', await callGet('/api/v2/voucher/get_voucher_list', token, shopId, { status: 'all', page_no: '1', page_size: '20' }));
  await new Promise(r => setTimeout(r, 400));

  // 3) Flash sale da loja (janela: agora → +30 dias)
  dump('shop_flash_sale/get_shop_flash_sale_list', await callGet('/api/v2/shop_flash_sale/get_shop_flash_sale_list', token, shopId, {
    type: '0', start_time: String(nowSec()), end_time: String(nowSec() + 30 * 24 * 3600), offset: '0', limit: '20',
  }));

  console.log('\n  ✅ = liberado. Confirme os campos de PRAZO (start_time/end_time) e status. Cole a saída aqui.\n');
  await pool.end();
})();
