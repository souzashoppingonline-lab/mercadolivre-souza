// Backfill (roda UMA vez): preenche shopee_order_data.tracking_number pros
// pedidos Shopee que já estão no banco. O worker passa a preencher sozinho os
// novos (ver marketplaceEventWorker.js), mas os que já foram processados antes
// da coluna existir precisam disso. Idempotente — só busca os que estão NULL.
//
//   cd /opt/ml-dashboard-novo/server && node backfill-shopee-tracking.js
require('dotenv').config();
const pool = require('./src/db/pool');
const env = require('./src/config/env');
const { ShopeeClient } = require('./src/marketplaces/shopee/shopeeClient');

(async () => {
  console.log('\n== Backfill tracking Shopee ==');

  // Uma instância de client por conta Shopee (com seus tokens).
  const { rows: stores } = await pool.query(
    `SELECT s.id, s.nickname, s.shopee_shop_id, s.access_token, s.refresh_token
       FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL`
  );
  if (!stores.length) { console.log('  nenhuma conta Shopee conectada'); return pool.end(); }

  const clients = new Map();
  for (const s of stores) {
    clients.set(s.id, new ShopeeClient({
      ...env.shopee,
      shopId: s.shopee_shop_id,
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
    }));
  }

  // Pedidos Shopee sem tracking ainda
  const { rows: pend } = await pool.query(
    `SELECT sod.order_sn, o.store_id
       FROM shopee_order_data sod
       JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.tracking_number IS NULL
      ORDER BY o.date_created DESC`
  );
  console.log(`  ${pend.length} pedido(s) sem tracking\n`);

  let ok = 0, vazio = 0, erro = 0;
  for (const p of pend) {
    const client = clients.get(p.store_id);
    if (!client) { console.log(`  ⚠️  ${p.order_sn}: sem client pra store_id=${p.store_id}`); erro++; continue; }
    try {
      const tn = await client.getTrackingNumber(p.order_sn);
      if (tn) {
        await pool.query(`UPDATE shopee_order_data SET tracking_number = $1, updated_at = now() WHERE order_sn = $2`, [tn, p.order_sn]);
        console.log(`  ✅ ${p.order_sn} → ${tn}`);
        ok++;
      } else {
        console.log(`  ·  ${p.order_sn} → (sem rastreio ainda — pedido não preparado)`);
        vazio++;
      }
    } catch (e) {
      console.log(`  ❌ ${p.order_sn} → ${e.message}`);
      erro++;
    }
    await new Promise((r) => setTimeout(r, 400)); // gentil com o rate limit
  }

  console.log(`\n  Concluído: ${ok} preenchidos, ${vazio} sem rastreio ainda, ${erro} erro(s).\n`);
  await pool.end();
})();
