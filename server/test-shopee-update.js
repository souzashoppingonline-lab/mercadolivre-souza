// Verificação do contrato de ESCRITA do Product API (update_stock) SEM alterar
// nada: lê o estoque atual da 1ª variação do 1º item e regrava o MESMO valor
// (no-op). Se voltar 200 sem erro, o update_stock/update_price funciona na sua
// conta e a página de Estoque & Preço pode gravar com segurança.
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-update.js
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

async function callPost(apiPath, token, shopId, body) {
  const ts = nowSec();
  const qs = new URLSearchParams({
    partner_id: PARTNER_ID, timestamp: String(ts), sign: sign(apiPath, ts, token, shopId),
    access_token: token, shop_id: String(shopId),
  });
  const res = await fetch(`${BASE}${apiPath}?${qs}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n== Shopee update_stock — verificação NO-OP (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  // pega 1 item e sua 1ª variação com estoque
  const list = await callGet('/api/v2/product/get_item_list', token, shopId, { offset: '0', page_size: '1', item_status: 'NORMAL' });
  const itemId = list.body?.response?.item?.[0]?.item_id;
  if (!itemId) { console.log('  sem itens ativos'); return pool.end(); }
  const models = await callGet('/api/v2/product/get_model_list', token, shopId, { item_id: String(itemId) });
  const model = models.body?.response?.model?.[0];
  const modelId = model?.model_id || 0;
  const currentStock = Number(model?.stock_info_v2?.summary_info?.total_available_stock ?? model?.stock_info_v2?.seller_stock?.[0]?.stock ?? 0);

  console.log(`\nitem_id=${itemId} model_id=${modelId} estoque_atual=${currentStock}`);
  console.log('Regravando o MESMO valor (no-op) — não altera o estoque real...');

  const r = await callPost('/api/v2/product/update_stock', token, shopId, {
    item_id: Number(itemId),
    stock_list: [{ model_id: Number(modelId), seller_stock: [{ stock: currentStock }] }],
  });
  const ok = r.status === 200 && !r.body.error;
  console.log(`\n${ok ? '✅ update_stock OK — escrita liberada' : '❌ update_stock falhou'} [${r.status}] ${r.body.error || ''} ${r.body.message || ''}`.trim());
  console.log(JSON.stringify(r.body, null, 2).slice(0, 1200));
  console.log('\n  Se deu ✅, a página de Estoque & Preço pode gravar. Cole a saída aqui.\n');
  await pool.end();
})();
