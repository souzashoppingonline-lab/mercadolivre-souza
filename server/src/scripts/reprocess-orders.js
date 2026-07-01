// Reprocesses recent orders (last 30 days) that are missing financial data
// (ml_fee = 0), fetching each from the ML API to fill in sale_fee and shipping.
// Run once: node server/src/scripts/reprocess-orders.js
require('dotenv').config();
const pool = require('../db/pool');
const ml   = require('../mlClient');

const DAYS = 30;

async function run() {
  const { rows } = await pool.query(
    `SELECT ml_id, store_id FROM orders
     WHERE ml_fee = 0
       AND date_created >= CURRENT_DATE - $1::int
       AND status != 'cancelled'
     ORDER BY date_created DESC`,
    [DAYS]
  );

  console.log(`[reprocess] ${rows.length} pedidos para atualizar (últimos ${DAYS} dias)`);
  if (!rows.length) { await pool.end(); return; }

  let ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const order = await ml.getOrder(row.ml_id, row.store_id);
      const item0 = order.order_items?.[0] || {};
      const shippingType = (order.shipping?.logistic_type || '')
        .replace('FULFILLMENT', 'Full')
        .replace('ME2', 'ME2')
        .replace('FLEX', 'Flex')
        .replace('PICKUP', 'Coleta');

      await pool.query(
        `UPDATE orders SET
           item_id       = $2,
           quantity      = $3,
           unit_price    = $4,
           ml_fee        = $5,
           shipping_type = $6,
           shipping_cost = $7,
           updated_at    = now()
         WHERE ml_id = $1`,
        [
          row.ml_id,
          item0.item?.id || null,
          item0.quantity || 1,
          item0.unit_price || order.total_amount || 0,
          item0.sale_fee || 0,
          shippingType,
          order.shipping?.cost || 0,
        ]
      );
      ok++;
      process.stdout.write(`\r[reprocess] ${ok}/${rows.length} ok  ${fail} erros`);
      await new Promise(r => setTimeout(r, 200)); // avoid rate limit
    } catch (err) {
      fail++;
      console.error(`\n[reprocess] erro no pedido ${row.ml_id}:`, err.message);
    }
  }

  console.log(`\n[reprocess] concluído — ${ok} atualizados, ${fail} erros`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
