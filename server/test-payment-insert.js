require('dotenv').config();
const pool = require('./src/db/pool');
const ml = require('./src/mlClient');

const PAYMENT_ID = process.argv[2];
const STORE_ID = process.argv[3];

if (!PAYMENT_ID || !STORE_ID) {
  console.error('uso: node test-payment-insert.js <paymentId> <storeId>');
  process.exit(1);
}

(async () => {
  const payment = await ml.getPayment(PAYMENT_ID, STORE_ID);
  console.log('payment completo:', JSON.stringify(payment));

  const orderId = payment?.collection?.order?.id || payment?.order?.id || payment?.order_id;
  console.log('orderId extraído:', orderId);
  if (!orderId) { console.log('SEM order_id — pararia aqui no handlePayment real (return antes do INSERT)'); process.exit(0); }

  const orderExists = await pool.query('SELECT ml_id FROM orders WHERE ml_id=$1', [String(orderId)]);
  console.log('order já existe em orders?', orderExists.rows.length > 0);

  const c = payment?.collection || payment;
  try {
    const res = await pool.query(
      `INSERT INTO ml_payments (
         payment_id, order_id, store_id, status, status_detail, transaction_amount,
         date_created, date_approved, net_received_amount, money_release_date, released,
         marketplace_fee, mercadopago_fee, discount_fee, coupon_fee, finance_fee,
         amount_refunded, shipping_cost, payment_method_id, payment_type, installments,
         raw_data, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (payment_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
       RETURNING id`,
      [
        c?.id || PAYMENT_ID, String(orderId), STORE_ID, c?.status || null, c?.status_detail || null,
        c?.transaction_amount || null, c?.date_created || null, c?.date_approved || null,
        c?.net_received_amount ?? null, c?.money_release_date || null, c?.released ?? null,
        c?.marketplace_fee ?? null, c?.mercadopago_fee ?? null, c?.discount_fee ?? null,
        c?.coupon_fee ?? null, c?.finance_fee ?? null, c?.amount_refunded ?? null,
        c?.shipping_cost ?? null, c?.payment_method_id || null, c?.payment_type || null,
        c?.installments ?? null, JSON.stringify(payment),
      ]
    );
    console.log('INSERT OK, id=', res.rows[0]?.id);
  } catch (e) {
    console.error('INSERT FALHOU:', e.message);
  }
  process.exit(0);
})().catch(e => { console.error('erro geral:', e.message); process.exit(1); });
