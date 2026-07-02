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

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false });
connection.on('error', (err) => console.error('[worker] redis connection error:', err.message));

process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — process will exit:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — process will exit:', err);
});

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

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const j = await r.json();
    return j?.result?.message_id || null;
  } catch (e) {
    console.error('[worker] tgNotify error:', e.message);
    return null;
  }
}

const noop = () => {};  // topics we receive but don't need to process

async function handleShipment({ resource, storeId }) {
  // Sem chamada ML API — apenas registra que houve movimentação de envio
  // O status real do pedido será atualizado no sync diário das 03:00
  const shipmentId = resource.split('/').pop();
  await pool.query(
    `UPDATE orders SET updated_at = now() WHERE store_id = $1 AND raw_data->>'shipment_id' = $2`,
    [storeId, String(shipmentId)]
  );
  await publish('order_updated', { shipment_id: shipmentId });
}

const handlers = {
  orders_v2:         handleOrder,
  payments:          handleOrder,
  questions:         handleQuestion,
  messages:          handleMessage,
  items:             handleItem,
  public_offers:     handleOffer,
  post_purchase:     handlePostPurchase,
  items_prices:      handleItemPrice,
  shipments:         handleShipment,
  invoices:          noop,
  public_candidates: noop,
};

async function handleOrder({ resource, storeId }) {
  const orderId = resource.split('/').pop();

  // Skip duplicate — if this order was already fetched in the last 10 minutes, don't call ML API again
  const recent = await pool.query(
    `SELECT ml_id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '10 minutes'`, [orderId]
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
    `SELECT ml_id FROM questions WHERE ml_id=$1 AND updated_at > now() - interval '10 minutes'`, [questionId]
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

  await publish('question_received', { id: q.id, status: q.status, text: q.text });
  if (q.status === 'UNANSWERED') {
    const { rows: storeRows } = await pool.query(`SELECT nickname FROM stores WHERE id=$1`, [storeId]);
    const loja = storeRows[0]?.nickname || `Loja ${storeId}`;
    const dashUrl = (process.env.DASH_URL || 'https://multimixvendas.duckdns.org') + '/pages/perguntas.html';
    const msgId = await tgNotify('tg_perguntas',
      `❓ <b>Nova pergunta sem resposta</b>\n🏪 Loja: <b>${loja}</b>\n🏷️ Item: ${q.item_id||'—'}\n💬 ${(q.text||'').slice(0,300)}\n\n` +
      `💡 <i>Responda esta mensagem no Telegram para responder ao comprador</i>\n` +
      `📋 ID: <code>${q.id}</code>\n<a href="${dashUrl}">Abrir dashboard →</a>`
    );
    // Save tg_message_id so the webhook can match replies
    if (msgId) {
      await pool.query(
        `UPDATE questions SET tg_message_id=$2 WHERE ml_id=$1`,
        [q.id, msgId]
      ).catch(() => {}); // column may not exist yet — ignore
    }
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

  await pool.query(
    `UPDATE items SET updated_at = now() WHERE ml_id = $1`,
    [itemId]
  );

  await pool.query(
    `INSERT INTO item_changes (item_id, store_id, changes, changed_at) VALUES ($1,$2,$3,now())`,
    [itemId, storeId, JSON.stringify([{ field: 'alterado', old: null, new: null }])]
  );

  await publish('anuncio_updated', { id: itemId });
}

async function handlePostPurchase({ resource, storeId }) {
  const claimId = resource.split('/').pop();
  try {
    const claim = await ml.get(`/post-purchase/claims/${claimId}`, storeId);
    const orderId = claim.order_id || null;
    await pool.query(
      `INSERT INTO returns (store_id, order_id, title, reason, amount, status, date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT DO NOTHING`,
      [storeId, orderId, claim.resolution?.reason || claim.reason_id || null,
       claim.reason_id || null, claim.total || 0, claim.status, claim.date_created]
    );
    await publish('devolucao_recebida', { store_id: storeId, claim_id: claimId, status: claim.status });
    if (claim.status === 'opened') {
      await tgNotify('tg_devolucoes', `🔄 <b>Nova devolução solicitada</b>\n📦 Pedido: ${orderId||'—'}\n💬 Motivo: ${claim.reason_id||'—'}\n💰 Valor: R$ ${Number(claim.total||0).toFixed(2)}`);
    }
  } catch (e) {
    console.warn(`[worker] handlePostPurchase fallback (${e.message})`);
  }
}

async function handleItemPrice({ resource, storeId }) {
  const itemId = resource.split('/').filter(Boolean)[1]; // /items/{id}/prices
  if (!itemId) return;
  const { rows } = await pool.query(`SELECT price FROM items WHERE ml_id=$1 LIMIT 1`, [itemId]);
  const oldPrice = Number(rows[0]?.price || 0);
  if (!rows.length) return; // item não está no nosso banco ainda
  // Pega novo preço do webhook resource — sem chamar ML API
  // O novo preço chegará via webhook 'items' na próxima atualização; apenas registramos a mudança
  await pool.query(
    `INSERT INTO price_history (store_id, item_id, old_price, new_price, changed_at)
     VALUES ($1,$2,$3,$3,now())`,
    [storeId, itemId, oldPrice]
  );
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

  // Get current and historical prices from local DB — zero extra API calls
  if (itemId) {
    const itemRow = await pool.query(
      `SELECT price FROM items WHERE ml_id=$1 LIMIT 1`, [itemId]
    );
    promoPrice = Number(itemRow.rows[0]?.price || 0);

    // Use price_history to get the pre-promo (original) price
    const histRow = await pool.query(
      `SELECT old_price FROM price_history WHERE item_id=$1 ORDER BY changed_at DESC LIMIT 1`, [itemId]
    );
    originalPrice = Number(histRow.rows[0]?.old_price || promoPrice);
  }

  if (originalPrice > 0 && promoPrice > 0 && originalPrice > promoPrice) {
    discountPct = ((originalPrice - promoPrice) / originalPrice) * 100;
  }

  try {
    const offer = await ml.getOffer(offerId, storeId);
    currentStatus = offer.status?.id || offer.status || currentStatus;
    rawData       = offer;
    if (!itemTitle) itemTitle = offer.title || null;
    // If ML returns discount info, prefer it
    if (offer.offers?.[0]?.original_value) originalPrice = Number(offer.offers[0].original_value);
    if (offer.offers?.[0]?.new_value)      promoPrice    = Number(offer.offers[0].new_value);
    if (originalPrice > 0 && promoPrice > 0) discountPct = ((originalPrice - promoPrice) / originalPrice) * 100;
  } catch (e) {
    console.warn(`[worker] getOffer fallback (${e.message}) — using local prices`);
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

      if (err.permanent || err.message?.includes('TOKEN_INVALID')) {
        // Token permanently invalid — discard job, no retry, alert via Telegram
        tgNotify('tg_token', `⚠️ Loja ${storeId} com token inválido. Reconecte em /auth/login`);
        return; // do NOT throw — prevents BullMQ from retrying
      }
      if (err.message?.includes('OAUTH_RATE_LIMITED')) {
        // Notify only once per store per hour — avoid Telegram flood from queued jobs
        const now = Date.now();
        const lastNotified = oauthNotified.get(storeId) || 0;
        if (now - lastNotified > 60 * 60 * 1000) {
          oauthNotified.set(storeId, now);
          tgNotify('tg_429', `🔐 <b>OAuth rate limit loja ${storeId}</b>\nPróxima tentativa automática em 35 min.\nSe persistir após 1h: reconecte a loja em /lojas`).catch(() => {});
        }
        return; // do NOT throw — BullMQ won't retry; cooldown in mlClient prevents flood
      }
      if (err.message?.includes('429')) {
        if (['items', 'questions', 'messages'].includes(job.name) && job.attemptsMade < 4) {
          console.warn(`[worker] RATE_LIMITED ${job.name}#${job.id} — attempt ${job.attemptsMade + 1}/5, will retry`);
          throw err; // BullMQ retries with exponential backoff (10s, 20s, 40s, 80s)
        }
        console.warn(`[worker] RATE_LIMITED drop ${job.name}#${job.id} — not retrying`);
        return;
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

worker.on('error', (err) => console.error('[worker] worker error event:', err.message));
worker.on('completed', (job) => { console.log(`[worker] done ${job.name}#${job.id}`); recentFailures = 0; });
worker.on('failed', (job, err) => {
  console.error(`[worker] failed ${job?.name}#${job?.id}`, err.message);
  recentFailures++;
  if (recentFailures === 5) {
    tgNotify('tg_fila', `🚨 <b>Fila BullMQ com erros consecutivos!</b>\n${recentFailures} jobs falharam seguidos.\nVerifique os logs: <code>journalctl -u ml-worker-novo -n 50</code>`).catch(() => {});
  }
});
let recentFailures = 0;
const oauthNotified = new Map(); // storeId → last Telegram notification timestamp

// ── Daily reconciliation at 03:00 ────────────────────────────
// Fetches orders from the last 25h per store and upserts any that were missed
// by the webhook pipeline. 1 API call per store = safe against 429.
async function dailySync() {
  console.log('[sync] iniciando reconciliação diária...');
  const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores`);
  const dateFrom = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  for (const store of stores) {
    // Alerta de token expirando em < 24h
    const expiresIn = store.token_expires_at ? (new Date(store.token_expires_at) - Date.now()) : -1;
    if (expiresIn < 0) {
      await tgNotify('tg_token', `🔴 <b>Token expirado!</b>\n🏪 Loja: ${store.nickname}\nReconecte em /pages/lojas.html`);
      continue; // sem token válido, pula o sync desta loja
    }
    if (expiresIn < 24 * 60 * 60 * 1000) {
      const horas = Math.floor(expiresIn / 3600000);
      await tgNotify('tg_token', `⚠️ <b>Token expira em ${horas}h!</b>\n🏪 Loja: ${store.nickname}\nReconecte em breve`);
    }

    try {
      await new Promise(r => setTimeout(r, 8000));

      // Reputação do vendedor (1 chamada/loja/dia)
      try {
        const rep = await ml.getSellerReputation(store.id);
        if (rep) {
          await pool.query(
            `INSERT INTO store_metrics (store_id, level_id, power_seller_status, transactions_completed,
               positive_ratings_pct, negative_ratings_pct, neutral_ratings_pct, collected_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
            [store.id, rep.level_id, rep.power_seller_status,
             rep.transactions?.total || 0,
             rep.transactions?.ratings?.positive?.rate * 100 || 0,
             rep.transactions?.ratings?.negative?.rate * 100 || 0,
             rep.transactions?.ratings?.neutral?.rate * 100 || 0]
          );
        }
      } catch (e) {
        console.warn(`[sync] reputação store=${store.id}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 2000));

      // Visitas por anúncio (lotes de 50, 1 chamada por lote)
      try {
        const { rows: activeItems } = await pool.query(
          `SELECT ml_id FROM items WHERE store_id=$1 AND status='active' LIMIT 200`, [store.id]
        );
        const ids = activeItems.map(r => r.ml_id);
        const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().slice(0,10);
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
          const vData = await ml.getItemVisits(batch, yesterday, store.id);
          const visits = vData?.data || [];
          for (const v of visits) {
            const total = (v.visits || []).reduce((s, d) => s + (d.total || 0), 0);
            await pool.query(
              `INSERT INTO item_visits (store_id, item_id, visits, date)
               VALUES ($1,$2,$3,$4) ON CONFLICT (item_id, date) DO UPDATE SET visits=$3, collected_at=now()`,
              [store.id, v.id, total, yesterday]
            );
          }
          if (i + 50 < ids.length) await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        console.warn(`[sync] visitas store=${store.id}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 2000));

      // Reconciliação de pedidos das últimas 25h
      const data = await ml.searchOrders(store.id, dateFrom);
      const orders = data.results || [];
      console.log(`[sync] store=${store.id} → ${orders.length} pedidos`);

      for (const order of orders) {
        const exists = await pool.query(
          `SELECT ml_id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '25 hours'`, [order.id]
        );
        if (exists.rows.length) continue;
        await handleOrder({ resource: `/orders/${order.id}`, storeId: store.id });
        await new Promise(r => setTimeout(r, 1500));
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

// Listener para comandos manuais via Redis pub/sub (ex: trigger do painel)
const cmdSub = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000 });
cmdSub.subscribe('worker:cmd');
cmdSub.on('message', (channel, msg) => {
  try {
    const { cmd } = JSON.parse(msg);
    if (cmd === 'dailySync') {
      console.log('[worker] dailySync disparado manualmente');
      dailySync().catch(e => console.error('[worker] dailySync manual erro:', e.message));
    }
  } catch {}
});

console.log('[worker] listening for ml-webhooks jobs...');
