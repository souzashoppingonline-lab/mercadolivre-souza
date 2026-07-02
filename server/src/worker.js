// BullMQ Worker — consumes jobs enqueued by the Webhook Gateway, fetches ONLY
// the changed resource from the Mercado Livre API, writes it to PostgreSQL,
// refreshes the relevant Redis cache keys, and pushes a WebSocket update.
//
// Run as its own process: npm run worker
require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const pool = require('./db/pool');
const redis = require('./db/redis');
const ml = require('./mlClient');
const { publish } = require('./ws/hub');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

// Rate limiter: max 10 req/s por store para respeitar limite ML (50 req/s global)
const lastCallTime = {};
async function rateLimitedCall(storeId, fn) {
  const key = String(storeId);
  const now = Date.now();
  const last = lastCallTime[key] || 0;
  const wait = Math.max(0, 120 - (now - last)); // mínimo 120ms entre calls (≈8 req/s)
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallTime[key] = Date.now();
  return fn();
}

const handlers = {
  orders_v2: handleOrder,
  payments:  handleOrder,
  questions: handleQuestion,
  messages:  handleMessage,
  items:     handleItem,
};

async function invalidateKPIs(storeId) {
  await redis.del('kpis:summary');
  if (storeId) await redis.del(`kpis:${storeId}`);
}

// Sync store stats once per hour to avoid hammering ML API on every webhook
async function syncStoreStats(storeId) {
  const cacheKey = `store_synced:${storeId}`;
  if (await redis.get(cacheKey)) return;

  try {
    const [info, rep] = await Promise.all([
      ml.getSellerInfo(storeId),
      ml.getSellerReputation(storeId),
    ]);

    // Count active listings from DB (ML /users/:id doesn't always return live count)
    const { rows: listingRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM items WHERE store_id=$1 AND status='active'`,
      [BigInt(storeId)]
    );
    // Monthly revenue from orders this calendar month
    const { rows: revenueRows } = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) AS total
       FROM orders
       WHERE store_id=$1 AND status NOT IN ('cancelled')
         AND date_created >= date_trunc('month', NOW())`,
      [BigInt(storeId)]
    );

    const sellerRep = info.seller_reputation || {};
    const reputationData = {
      level_id:           sellerRep.level_id   || rep.level_id   || null,
      power_seller_status:sellerRep.power_seller_status || rep.power_seller_status || null,
      metrics:            sellerRep.metrics     || rep.metrics    || {},
      transactions:       sellerRep.transactions|| rep.transactions|| {},
    };

    await pool.query(
      `UPDATE stores
       SET nickname         = COALESCE($2, nickname),
           level_id         = $3,
           reputation_data  = $4,
           active_listings  = $5,
           monthly_revenue  = $6,
           updated_at       = now()
       WHERE id = $1`,
      [
        BigInt(storeId),
        info.nickname || null,
        reputationData.level_id,
        JSON.stringify(reputationData),
        parseInt(listingRows[0].n, 10),
        parseFloat(revenueRows[0].total),
      ]
    );

    await redis.set(cacheKey, '1', 'EX', 3600); // re-sync no máximo 1x/hora
    await publish('store_updated', { storeId });
  } catch (err) {
    console.error(`[worker] syncStoreStats ${storeId}:`, err.message);
  }
}

async function handleOrder({ resource, storeId }) {
  const orderId = resource.split('/').pop();
  const order = await rateLimitedCall(storeId, () => ml.getOrder(orderId, storeId));

  await pool.query(
    `INSERT INTO orders
       (ml_id, store_id, buyer_nickname, buyer_id, title, total_amount,
        status, date_created, date_closed, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       buyer_nickname = EXCLUDED.buyer_nickname,
       title          = EXCLUDED.title,
       total_amount   = EXCLUDED.total_amount,
       status         = EXCLUDED.status,
       date_closed    = EXCLUDED.date_closed,
       updated_at     = now()`,
    [
      order.id, storeId,
      order.buyer?.nickname, order.buyer?.id,
      order.order_items?.[0]?.item?.title || null,
      order.total_amount, order.status,
      order.date_created, order.date_closed,
    ]
  );

  await invalidateKPIs(storeId);
  await publish('order_updated', { id: order.id, status: order.status, total_amount: order.total_amount });
  await publish('kpis_updated', {});
  await syncStoreStats(storeId);
}

async function handleQuestion({ resource, storeId }) {
  const questionId = resource.split('/').pop();
  const q = await rateLimitedCall(storeId, () => ml.getQuestion(questionId, storeId));

  let itemTitle = null;
  if (q.item_id) {
    try {
      const item = await pool.query('SELECT title FROM items WHERE ml_id = $1', [q.item_id]);
      itemTitle = item.rows[0]?.title || null;
    } catch (_) {}
  }

  const answeredAt = q.answer?.date_created || null;

  await pool.query(
    `INSERT INTO questions
       (ml_id, store_id, item_id, item_title, text, answer_text, answered_at,
        status, date_created, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       answer_text = EXCLUDED.answer_text,
       answered_at = EXCLUDED.answered_at,
       status      = EXCLUDED.status,
       updated_at  = now()`,
    [
      q.id, storeId, q.item_id, itemTitle,
      q.text, q.answer?.text || null, answeredAt,
      q.status, q.date_created,
    ]
  );

  await publish('question_received', { id: q.id, status: q.status });
  await publish('kpis_updated', {});
}

async function handleMessage({ resource, storeId }) {
  const packId = resource.split('/').filter(Boolean).pop();
  const pack = await rateLimitedCall(storeId, () => ml.getMessagesPack(packId, storeId));
  const last = pack.messages?.[pack.messages.length - 1];

  await pool.query(
    `INSERT INTO messages
       (store_id, pack_id, buyer_nickname, last_message, unread, last_message_date, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT DO NOTHING`,
    [
      storeId, packId,
      pack.buyer?.nickname || null,
      last?.text || null,
      pack.unread_count || 0,
      last?.message_date?.received,
    ]
  );

  await publish('message_received', { pack_id: packId });
}

async function handleItem({ resource, storeId }) {
  const itemId = resource.split('/').pop();
  const item = await rateLimitedCall(storeId, () => ml.getItem(itemId, storeId));

  await pool.query(
    `INSERT INTO items
       (ml_id, store_id, title, price, available_quantity, sold_quantity,
        status, category_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       title              = EXCLUDED.title,
       price              = EXCLUDED.price,
       available_quantity = EXCLUDED.available_quantity,
       sold_quantity      = EXCLUDED.sold_quantity,
       status             = EXCLUDED.status,
       updated_at         = now()`,
    [
      item.id, storeId, item.title, item.price,
      item.available_quantity, item.sold_quantity,
      item.status, item.category_id,
    ]
  );

  await invalidateKPIs(storeId);

  if (item.available_quantity <= 3) {
    await publish('stock_alert', {
      id: item.id, title: item.title, stock: item.available_quantity,
    });
  }
  await publish('anuncio_updated', { id: item.id, status: item.status });
  await publish('kpis_updated', {});
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
      await pool.query(
        `UPDATE webhook_logs SET status='processed', processed_at=now() WHERE id=$1`,
        [logId]
      );
    } catch (err) {
      await pool.query(
        `UPDATE webhook_logs SET status='failed', error=$2, processed_at=now() WHERE id=$1`,
        [logId, err.message]
      );
      throw err;
    }
  },
  { connection, concurrency: 2 }
);

worker.on('completed', (job) =>
  console.log(`[worker] done ${job.name}#${job.id}`)
);
worker.on('failed', (job, err) =>
  console.error(`[worker] failed ${job?.name}#${job?.id}`, err.message)
);

console.log('[worker] listening for ml-webhooks jobs...');
