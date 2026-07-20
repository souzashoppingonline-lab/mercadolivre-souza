// Backfill (roda UMA vez): preenche financeiro (escrow) + status de entrega dos
// pedidos Shopee que já estão no banco. O worker passa a preencher os novos
// sozinho; este cobre os antigos. Idempotente — só busca os que estão sem escrow.
//
//   cd /opt/ml-dashboard-novo/server && node backfill-shopee-financeiro.js
require('dotenv').config();
const pool = require('./src/db/pool');
const env = require('./src/config/env');
const { ShopeeClient } = require('./src/marketplaces/shopee/shopeeClient');

(async () => {
  console.log('\n== Backfill financeiro (escrow) + entrega Shopee ==');
  const { rows: stores } = await pool.query(
    `SELECT s.id, s.nickname, s.shopee_shop_id, s.access_token, s.refresh_token
       FROM stores s JOIN marketplaces m ON m.id = s.marketplace_id
      WHERE m.code = 'SHOPEE' AND s.access_token IS NOT NULL`);
  if (!stores.length) { console.log('  nenhuma conta Shopee conectada'); return pool.end(); }

  const clients = new Map();
  for (const s of stores) {
    clients.set(s.id, new ShopeeClient({ ...env.shopee, shopId: s.shopee_shop_id, accessToken: s.access_token, refreshToken: s.refresh_token }));
  }

  const { rows: pend } = await pool.query(
    `SELECT sod.order_sn, o.store_id
       FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.escrow_amount IS NULL
      ORDER BY o.date_created DESC`);
  console.log(`  ${pend.length} pedido(s) sem financeiro\n`);

  let ok = 0, vazio = 0, erro = 0;
  for (const p of pend) {
    const client = clients.get(p.store_id);
    if (!client) { console.log(`  ⚠️  ${p.order_sn}: sem client`); erro++; continue; }
    try {
      let escrow = null, logistics = null;
      try { escrow = await client.getEscrowDetail(p.order_sn); } catch (e) { /* ainda não apurado */ }
      try { logistics = (await client.getTrackingInfo(p.order_sn))?.logistics_status || null; } catch (e) { /* sem envio ainda */ }
      const inc = escrow?.order_income || {};
      if (escrow || logistics) {
        await pool.query(
          `UPDATE shopee_order_data SET
             buyer_total = COALESCE($1, buyer_total),
             commission_fee = COALESCE($2, commission_fee),
             escrow_amount = COALESCE($3, escrow_amount),
             buyer_payment_method = COALESCE($4, buyer_payment_method),
             escrow_raw = COALESCE($5, escrow_raw),
             logistics_status = COALESCE($6, logistics_status),
             updated_at = now()
           WHERE order_sn = $7`,
          [
            escrow ? Number(inc.buyer_total_amount ?? 0) : null,
            escrow ? Number(inc.commission_fee ?? 0) : null,
            escrow ? Number(inc.escrow_amount ?? 0) : null,
            escrow ? (inc.buyer_payment_method || null) : null,
            escrow ? JSON.stringify(escrow) : null,
            logistics,
            p.order_sn,
          ]);
        console.log(`  ✅ ${p.order_sn} → líquido ${escrow ? 'R$ ' + Number(inc.escrow_amount ?? 0).toFixed(2) : '—'} · entrega ${logistics || '—'}`);
        ok++;
      } else {
        console.log(`  ·  ${p.order_sn} → sem escrow/entrega ainda`);
        vazio++;
      }
    } catch (e) {
      console.log(`  ❌ ${p.order_sn} → ${e.message}`);
      erro++;
    }
    await new Promise((r) => setTimeout(r, 500)); // throttle — gentil com o rate limit
  }

  console.log(`\n  Concluído: ${ok} preenchidos, ${vazio} sem dado ainda, ${erro} erro(s).\n`);
  await pool.end();
})();
