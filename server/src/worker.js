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

// ── Telegram notification helper ─────────────────────────
let _tgLastSent = {};
async function tgNotify(topic, text) {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [['telegram_bot_token','telegram_chat_id', topic, 'tg_interval','silence_start','silence_end']]
    );
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const token  = cfg.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = cfg.telegram_chat_id   || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    if (cfg[topic] === 'false' || cfg[topic] === false) return;

    // Silence window check
    const now = new Date();
    const hhmm = now.toTimeString().slice(0,5);
    const ss = cfg.silence_start || '22:00';
    const se = cfg.silence_end   || '07:00';
    const inSilence = ss > se ? (hhmm >= ss || hhmm < se) : (hhmm >= ss && hhmm < se);
    if (inSilence) return;

    // Interval throttle
    const interval = Number(cfg.tg_interval || 0) * 60 * 1000;
    if (interval > 0) {
      const last = _tgLastSent[topic] || 0;
      if (Date.now() - last < interval) return;
    }
    _tgLastSent[topic] = Date.now();

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[worker] tgNotify error:', e.message);
  }
}

const noop = () => {};  // topics we receive but don't need to process

const handlers = {
  orders_v2:         handleOrder,
  payments:          handleOrder,
  questions:         handleQuestion,
  messages:          handleMessage,
  items:             handleItem,
  public_offers:     handleOffer,
  shipments:         noop,
  items_prices:      noop,
  post_purchase:     noop,
  invoices:          noop,
  public_candidates: noop,
};

async function handleOrder({ resource, storeId }) {
  const orderId = resource.split('/').pop();

  // Skip duplicate — if this order was already fetched in the last 10 minutes, don't call ML API again
  const recent = await pool.query(
    `SELECT id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '10 minutes'`, [orderId]
  );
  if (recent.rows.length) return;

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

  if (order.status === 'paid') {
    const val = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(order.total_amount)||0);
    await tgNotify('tg_vendas', `🛒 <b>Nova venda!</b>\n📦 ${item0.item?.title||'—'}\n💰 ${val}\n👤 ${order.buyer?.nickname||'—'}`);
  }
}

async function handleQuestion({ resource, storeId }) {
  const questionId = resource.split('/').pop();
  const recent = await pool.query(
    `SELECT id FROM questions WHERE ml_id=$1 AND updated_at > now() - interval '10 minutes'`, [questionId]
  );
  if (recent.rows.length) return;
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
  if (q.status === 'UNANSWERED') {
    await tgNotify('tg_perguntas', `❓ <b>Nova pergunta sem resposta</b>\n🏷️ Item: ${q.item_id||'—'}\n💬 ${(q.text||'').slice(0,200)}`);
  }
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
  await tgNotify('tg_mensagens', `💬 <b>Nova mensagem de comprador</b>\n👤 ${pack.buyer?.nickname||'—'}\n📝 ${(last?.text||'').slice(0,200)}`);
}

async function handleItem({ resource, storeId }) {
  const itemId = resource.split('/').pop();
  const recent = await pool.query(
    `SELECT ml_id FROM items WHERE ml_id=$1 AND updated_at > now() - interval '10 minutes'`, [itemId]
  );
  if (recent.rows.length) return;
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

  if (item.available_quantity <= 5) {
    await publish('stock_alert', { id: item.id, title: item.title, stock: item.available_quantity });
    await tgNotify('tg_reposicao', `⚠️ <b>Estoque crítico!</b>\n📦 ${item.title}\n🔢 Restam apenas ${item.available_quantity} unidades`);
  }
  await publish('anuncio_updated', { id: item.id, status: item.status });
}

async function handleOffer({ resource, storeId }) {
  const offerId = resource.split('/').pop();

  // Extract item_id directly from offer_id — avoids ML API call (no 429 risk)
  // Format: OFFER-MLB5436690816-13215330532
  const itemId = offerId.match(/OFFER-(MLB\d+)/)?.[1] || null;

  // Get item title from local DB — zero API calls
  let itemTitle = null;
  if (itemId) {
    const { rows } = await pool.query(`SELECT title, price FROM items WHERE ml_id = $1 LIMIT 1`, [itemId]);
    itemTitle = rows[0]?.title || null;
  }

  // Get previous status from last promotion record for this offer
  const prev = await pool.query(
    `SELECT status FROM promotions WHERE offer_id=$1 AND store_id=$2 ORDER BY changed_at DESC LIMIT 1`,
    [offerId, storeId]
  );
  const previousStatus = prev.rows[0]?.status || null;

  // Try ML API for offer details — with graceful fallback if 429
  let currentStatus = previousStatus === null ? 'active' : 'changed';
  let originalPrice = 0, promoPrice = 0, discountPct = 0;
  let rawData = { offer_id: offerId, resource };

  try {
    const offer = await ml.getOffer(offerId, storeId);
    currentStatus  = offer.status?.id || offer.status || currentStatus;
    rawData        = offer;
    if (!itemTitle) itemTitle = offer.title || null;

    // Offers endpoint has no price fields — get current price from items table
    if (itemId) {
      const itemRow = await pool.query(`SELECT price FROM items WHERE ml_id=$1 LIMIT 1`, [itemId]);
      promoPrice = Number(itemRow.rows[0]?.price || 0);
    }
  } catch (e) {
    // 429 or other error — save the event without price details, don't throw
    console.warn(`[worker] getOffer fallback (${e.message}) — saving without prices`);
  }

  await pool.query(
    `INSERT INTO promotions (store_id, offer_id, item_id, item_title, status, previous_status, original_price, promo_price, discount_pct, changed_at, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)`,
    [storeId, offerId, itemId, itemTitle, currentStatus, previousStatus,
     originalPrice, promoPrice, Number(discountPct.toFixed(2)), JSON.stringify(rawData)]
  );

  await publish('promo_changed', {
    store_id: storeId, offer_id: offerId, item_id: itemId, item_title: itemTitle,
    status: currentStatus, previous_status: previousStatus,
    promo_price: promoPrice, original_price: originalPrice, discount_pct: Number(discountPct.toFixed(2)),
  });

  const Rfmt = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  if (previousStatus === 'active' && currentStatus !== 'active') {
    await tgNotify('tg_promocoes', `🔴 <b>Saiu da promoção!</b>\n📦 ${itemTitle || itemId}\n💰 Preço voltou para ${Rfmt(originalPrice)}\n⚠️ Reative a promoção`);
  } else if (!previousStatus || (previousStatus !== 'active' && currentStatus === 'active')) {
    await tgNotify('tg_promocoes', `🟢 <b>Entrou em promoção!</b>\n📦 ${itemTitle || itemId}\n💰 ${Rfmt(promoPrice)}${discountPct > 0 ? ` (${discountPct.toFixed(0)}% off)` : ''}`);
  } else {
    await tgNotify('tg_promocoes', `🏷️ <b>Promoção alterada</b>\n📦 ${itemTitle || itemId}\n💰 ${Rfmt(promoPrice)}${discountPct > 0 ? ` (${discountPct.toFixed(0)}% off)` : ''}`);
  }
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
      // On 429 tell BullMQ to retry with exponential backoff
      if (err.message?.includes('429')) {
        err.message = `RATE_LIMITED: ${err.message}`;
      }
      throw err;
    }
  },
  {
    connection,
    concurrency: 1,  // one at a time — avoids burst 429s
    limiter: { max: 1, duration: 1500 },  // max 1 job per 1.5s
  }
);

worker.on('completed', (job) => console.log(`[worker] done ${job.name}#${job.id}`));
worker.on('failed', (job, err) => console.error(`[worker] failed ${job?.name}#${job?.id}`, err.message));

// ── Daily reconciliation at 03:00 ────────────────────────────
// Fetches orders from the last 25h per store and upserts any that were missed
// by the webhook pipeline. 1 API call per store = safe against 429.
async function dailySync() {
  console.log('[sync] iniciando reconciliação diária...');
  const { rows: stores } = await pool.query(
    `SELECT id FROM stores WHERE token_expires_at > now()`
  );

  const dateFrom = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  for (const store of stores) {
    try {
      await new Promise(r => setTimeout(r, 3000)); // 3s entre lojas
      const data = await ml.searchOrders(store.id, dateFrom);
      const orders = data.results || [];
      console.log(`[sync] store=${store.id} → ${orders.length} pedidos encontrados`);

      for (const order of orders) {
        const exists = await pool.query(
          `SELECT id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '25 hours'`,
          [order.id]
        );
        if (exists.rows.length) continue;

        // Reuse handleOrder logic by simulating the resource path
        await handleOrder({ resource: `/orders/${order.id}`, storeId: store.id });
        await new Promise(r => setTimeout(r, 1500)); // respeita rate limit
      }
    } catch (e) {
      console.error(`[sync] store=${store.id} erro:`, e.message);
    }
  }
  console.log('[sync] reconciliação concluída');
  scheduleDailySync();
}

function scheduleDailySync() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  const ms = next3am - now;
  console.log(`[sync] próxima reconciliação: ${next3am.toLocaleString('pt-BR')} (em ${Math.round(ms/60000)}min)`);
  setTimeout(dailySync, ms);
}

scheduleDailySync();
console.log('[worker] listening for ml-webhooks jobs...');
