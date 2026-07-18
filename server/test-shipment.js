require('dotenv').config();
const pool = require('./src/db/pool');
const ml = require('./src/mlClient');

(async () => {
  const { rows } = await pool.query(
    `SELECT id, nickname, access_token FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL`
  );
  for (const store of rows) {
    if (!store.access_token) { console.log(store.nickname, '— sem token'); continue; }
    const { rows: recentOrders } = await pool.query(
      `SELECT ml_id, shipping_id FROM orders WHERE store_id=$1 AND shipping_id IS NOT NULL ORDER BY date_created DESC LIMIT 1`,
      [store.id]
    );
    if (!recentOrders.length) { console.log(store.nickname, '— sem pedido com shipping_id ainda'); continue; }
    const { ml_id: orderId, shipping_id: shippingId } = recentOrders[0];
    console.log(`=== ${store.nickname} — order ${orderId} — shipping_id ${shippingId} ===`);
    try {
      const ship = await ml.getShipment(shippingId, store.id);
      console.log(JSON.stringify(ship, null, 2));
    } catch (e) {
      console.log('erro:', e.message);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
