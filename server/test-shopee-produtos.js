// Diagnóstico READ-ONLY do catálogo Shopee (Product API). Confirma os nomes
// REAIS dos campos antes de codar o sync de anúncios — igual fiz com escrow/
// tracking/chat. NÃO altera nada (só GET). Testa:
//   1) get_item_list        — lista os item_id da loja
//   2) get_item_base_info   — nome, preço, estoque, sku, status, categoria, foto
//   3) get_model_list       — variações (cor/tamanho) com preço/estoque por SKU
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-produtos.js
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

function dump(label, obj, max = 2200) {
  const s = JSON.stringify(obj, null, 2);
  console.log(`\n--- ${label} ---`);
  console.log(s && s.length > max ? s.slice(0, max) + '\n… (truncado)' : s);
}

(async () => {
  console.log(`\n== Shopee Product API — diagnóstico (${ENV}) ==`);
  const { rows: st } = await pool.query(
    `SELECT s.shopee_shop_id, s.access_token FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL ORDER BY s.id LIMIT 1`);
  if (!st.length) { console.log('  nenhuma conta Shopee'); return pool.end(); }
  const { shopee_shop_id: shopId, access_token: token } = st[0];

  // 1) get_item_list — item_status=NORMAL (ativos). offset/page_size obrigatórios.
  const list = await call('/api/v2/product/get_item_list', token, shopId, {
    offset: '0', page_size: '20', item_status: 'NORMAL',
  });
  const ok1 = list.status === 200 && !list.body.error;
  console.log(`\n${ok1 ? '✅' : '❌'} get_item_list [${list.status}] ${list.body.error || ''} ${list.body.message || ''}`.trim());
  const items = list.body?.response?.item || [];
  console.log(`  total_count=${list.body?.response?.total_count} · itens nesta página=${items.length} · has_next=${list.body?.response?.has_next_page}`);
  dump('get_item_list.response (resumo)', { item: items.slice(0, 5), total_count: list.body?.response?.total_count });
  if (!ok1 || !items.length) { console.log('\n  (sem itens ativos ou API não liberada — cole a saída aqui)'); return pool.end(); }

  const ids = items.slice(0, 5).map((i) => i.item_id).join(',');

  // 2) get_item_base_info — nome/preço/estoque/sku/status/categoria/foto
  const base = await call('/api/v2/product/get_item_base_info', token, shopId, { item_id_list: ids });
  const ok2 = base.status === 200 && !base.body.error;
  console.log(`\n${ok2 ? '✅' : '❌'} get_item_base_info [${base.status}] ${base.body.error || ''} ${base.body.message || ''}`.trim());
  dump('get_item_base_info.response.item_list[0]', base.body?.response?.item_list?.[0]);

  // 3) get_model_list — variações (preço/estoque por SKU) do 1º item
  const firstId = items[0].item_id;
  const models = await call('/api/v2/product/get_model_list', token, shopId, { item_id: String(firstId) });
  const ok3 = models.status === 200 && !models.body.error;
  console.log(`\n${ok3 ? '✅' : '❌'} get_model_list (item_id=${firstId}) [${models.status}] ${models.body.error || ''} ${models.body.message || ''}`.trim());
  dump('get_model_list.response', models.body?.response);

  console.log('\n  Confirme os campos de: nome, price_info (preço atual/original), stock_info (estoque), item_sku, item_status, category_id, image, e as variações (model). Cole a saída aqui.\n');
  await pool.end();
})();
