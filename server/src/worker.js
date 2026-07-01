// BullMQ Worker — consumes jobs enqueued by the Webhook Gateway, fetches ONLY
// the changed resource from the Mercado Livre API, writes it to PostgreSQL,
// refreshes the relevant Redis cache keys, and pushes a WebSocket update.
//
// Run as its own process: `npm run worker`
require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const pool = require('./db/pool');
const redis = require('./db/redis');
const ml = require('./mlClient');
const { publish } = require('./ws/hub');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

const handlers = {
  orders_v2: handleOrder,
  payments: handleOrder,
  questions: handleQuestion,
  messages: handleMessage,
  items: handleItem,
};

async function handleOrder({ resource, storeId }) {
  const orderId = resource.split('/').pop();
  const order = await ml.getOrder(orderId, storeId);

  const item0 = order.order_items?.[0] || {};
  const shippingType = (order.shipping?.logistic_type || '').replace('FULFILLMENT', 'Full').replace('ME2', 'ME2').replace('FLEX', 'Flex').replace('PICKUP', 'Coleta') || '';

  await pool.query(
    `INSERT INTO orders (ml_id, store_id, buyer_nickname, item_id, title, total_amount, quantity, unit_price, ml_fee, shipping_type, shipping_cost, status, date_created, date_closed, raw_data, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       buyer_nickname = EXCLUDED.buyer_nickname,
       item_id = EXCLUDED.item_id,
       title = EXCLUDED.title,
       total_amount = EXCLUDED.total_amount,
       quantity = EXCLUDED.quantity,
       unit_price = EXCLUDED.unit_price,
       ml_fee = EXCLUDED.ml_fee,
       shipping_type = EXCLUDED.shipping_type,
       shipping_cost = EXCLUDED.shipping_cost,
       status = EXCLUDED.status,
       date_closed = EXCLUDED.date_closed,
       raw_data = EXCLUDED.raw_data,
       updated_at = now()`,
    [
      order.id, storeId, order.buyer?.nickname,
      item0.item?.id || null,
      item0.item?.title || null,
      order.total_amount,
      item0.quantity || 1,
      item0.unit_price || order.total_amount || 0,
      item0.sale_fee || 0,
      shippingType,
      order.shipping?.cost || 0,
      order.status,
      order.date_created, order.date_closed,
      JSON.stringify(order),
    ]
  );

  await redis.del(`kpis:${storeId}`);
  await redis.del('kpis:summary');
  await publish('order_updated', { id: order.id, status: order.status });
}

async function handleQuestion({ resource, storeId }) {
  const questionId = resource.split('/').pop();
  const q = await ml.getQuestion(questionId, storeId);

  await pool.query(
    `INSERT INTO questions (ml_id, store_id, item_id, text, answer_text, status, date_created, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       answer_text = EXCLUDED.answer_text,
       status = EXCLUDED.status,
       updated_at = now()`,
    [q.id, storeId, q.item_id, q.text, q.answer?.text || null, q.status, q.date_created]
  );

  await publish('question_received', { id: q.id, status: q.status });
}

async function handleMessage({ resource, storeId }) {
  const packId = resource.split('/').filter(Boolean).pop();
  const pack = await ml.getMessagesPack(packId, storeId);
  const last = pack.messages?.[pack.messages.length - 1];

  await pool.query(
    `INSERT INTO messages (store_id, pack_id, buyer_nickname, last_message, unread, last_message_date, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [storeId, packId, pack.buyer?.nickname || null, last?.text || null, pack.unread_count || 0, last?.message_date?.received]
  );

  await publish('message_received', { pack_id: packId });
}

async function handleItem({ resource, storeId }) {
  const itemId = resource.split('/').pop();
  const item = await ml.getItem(itemId, storeId);

  await pool.query(
    `INSERT INTO items (ml_id, store_id, title, price, available_quantity, sold_quantity, status, category_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       title = EXCLUDED.title, price = EXCLUDED.price,
       available_quantity = EXCLUDED.available_quantity,
       sold_quantity = EXCLUDED.sold_quantity,
       status = EXCLUDED.status, updated_at = now()`,
    [item.id, storeId, item.title, item.price, item.available_quantity, item.sold_quantity, item.status, item.category_id]
  );

  if (item.available_quantity <= 3) {
    await publish('stock_alert', { id: item.id, title: item.title, stock: item.available_quantity });
  }
  await publish('anuncio_updated', { id: item.id, status: item.status });
}

const worker = new Worker(
  'ml-webhooks',
  async (job) => {
    const { topic, resource, storeId, logId } = job.data;
    const handler = handlers[topic];

    if (!handler) {
      console.warn(`[worker] no handler for topic=${topic}`);
      return;
    }

    try {
      await handler({ resource, storeId });
      await pool.query(`UPDATE webhook_logs SET status='processed', processed_at=now() WHERE id=$1`, [logId]);
    } catch (err) {
      await pool.query(`UPDATE webhook_logs SET status='failed', error=$2, processed_at=now() WHERE id=$1`, [logId, err.message]);
      throw err;
    }
  },
  { connection, concurrency: 5 }
);

worker.on('completed', (job) => console.log(`[worker] done ${job.name}#${job.id}`));
worker.on('failed', (job, err) => console.error(`[worker] failed ${job?.name}#${job?.id}`, err.message));

console.log('[worker] listening for ml-webhooks jobs...');
