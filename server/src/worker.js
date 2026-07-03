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
const { refreshToken } = require('./routes/auth');

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
  const shipmentId = resource.split('/').pop();

  // Busca o pedido vinculado a este shipment no banco local
  const { rows } = await pool.query(
    `SELECT ml_id FROM orders
     WHERE store_id = $1 AND raw_data->>'shipment_id' = $2
       AND updated_at < now() - interval '30 minutes'
     LIMIT 1`,
    [storeId, String(shipmentId)]
  );
  if (!rows.length) {
    // Pedido não existe ou foi atualizado nos últimos 30 min — apenas toca updated_at
    await pool.query(
      `UPDATE orders SET updated_at = now() WHERE store_id = $1 AND raw_data->>'shipment_id' = $2`,
      [storeId, String(shipmentId)]
    );
    await publish('order_updated', { shipment_id: shipmentId });
    return;
  }

  // Pedido existe e não foi atualizado recentemente — busca status atual
  const orderId = rows[0].ml_id;
  await handleOrder({ resource: `/orders/${orderId}`, storeId });
}

const handlers = {
  orders_v2:         handleOrder,
  payments:          noop,
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
    `SELECT ml_id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '30 minutes'`, [orderId]
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
    const { rows: storeRows } = await pool.query(`SELECT nickname FROM stores WHERE id=$1`, [storeId]);
    const loja = storeRows[0]?.nickname || `Loja ${storeId}`;
    let envioLabel = shippingType || '—';
    try {
      const shipmentId = order.shipping?.id;
      if (shipmentId) {
        const shipment = await ml.getShipment(shipmentId, storeId);
        const lt = (shipment?.logistic_type || '').toLowerCase();
        envioLabel = lt.includes('fulfillment') ? '📦 FULL'
          : lt.includes('flex')   ? '🏃 Flex'
          : lt.includes('me2')    ? '📮 ME2'
          : lt.includes('me1')    ? '📮 ME1'
          : lt || shippingType || '—';
      }
    } catch (e) {
      console.warn(`[worker] getShipment erro:`, e.message);
    }
    await tgNotify('tg_vendas', `🛒 <b>Nova venda!</b>\n🏪 ${loja}\n📦 ${item0.item?.title||'—'}\n💰 ${val}\n🚚 ${envioLabel}\n👤 ${order.buyer?.nickname||'—'}`);
  }
}

async function handleQuestion({ resource, storeId }) {
  const questionId = resource.split('/').pop();
  const recent = await pool.query(
    `SELECT ml_id FROM questions WHERE ml_id=$1 AND updated_at > now() - interval '30 minutes'`, [questionId]
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
  // resource = /messages/packs/{messageId} — o ID é da mensagem, não do pack
  const msgId = resource.split('/').filter(Boolean).pop();
  const msg = await ml.getMessage(msgId, storeId);

  // msg.pack_id é o ID numérico do pack/conversa; fallback para o próprio msgId
  const packId = msg.pack_id ? String(msg.pack_id) : msgId;
  // Tenta extrair nickname do comprador de diferentes campos da resposta ML
  const buyerNickname = msg.from?.nickname
    || msg.order?.buyer?.nickname
    || (msg.from?.user_id ? String(msg.from.user_id) : null);
  const text = msg.text || null;
  const msgDate = msg.message_date?.received || msg.message_date?.created || null;
  console.log(`[msg-debug] msgId=${msgId} packId=${packId} from=${JSON.stringify(msg.from)} buyer=${buyerNickname}`);

  await pool.query(
    `INSERT INTO messages (store_id, pack_id, buyer_nickname, last_message, unread, last_message_date, updated_at)
     VALUES ($1,$2,$3,$4,1,$5, now())
     ON CONFLICT (pack_id) DO UPDATE SET
       last_message = EXCLUDED.last_message,
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, messages.buyer_nickname),
       unread = messages.unread + 1,
       last_message_date = EXCLUDED.last_message_date,
       updated_at = now()`,
    [storeId, packId, buyerNickname, text, msgDate]
  );

  await publish('message_received', { pack_id: packId });
  await tgNotify('tg_mensagens', `💬 <b>Nova mensagem de comprador</b>\n👤 ${buyerNickname||'—'}\n📝 ${(text||'').slice(0,200)}`);
}

async function handleItem({ resource, storeId }) {
  const itemId = resource.split('/').pop();
  const recent = await pool.query(
    `SELECT ml_id FROM items WHERE ml_id=$1 AND updated_at > now() - interval '30 minutes'`, [itemId]
  );
  if (recent.rows.length) return;

  const { rows: old } = await pool.query(`SELECT price, available_quantity, status, title FROM items WHERE ml_id=$1`, [itemId]);
  const prev = old[0];

  const item = await ml.getItem(itemId, storeId);
  const thumb = item.thumbnail || (item.pictures?.[0]?.url) || null;

  const parentId = item.parent_item_id || null;
  await pool.query(
    `INSERT INTO items (ml_id, store_id, title, price, available_quantity, sold_quantity, status, category_id, thumbnail, permalink, parent_item_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       title = EXCLUDED.title, price = EXCLUDED.price,
       available_quantity = EXCLUDED.available_quantity,
       sold_quantity = EXCLUDED.sold_quantity,
       status = EXCLUDED.status,
       thumbnail = COALESCE(EXCLUDED.thumbnail, items.thumbnail),
       permalink = COALESCE(EXCLUDED.permalink, items.permalink),
       parent_item_id = COALESCE(EXCLUDED.parent_item_id, items.parent_item_id),
       updated_at = now()`,
    [item.id, storeId, item.title, item.price, item.available_quantity, item.sold_quantity, item.status, item.category_id, thumb, item.permalink || null, parentId]
  );

  const { rows: storeRows } = await pool.query(`SELECT nickname FROM stores WHERE id=$1`, [storeId]);
  const lojaNome = storeRows[0]?.nickname || `Loja ${storeId}`;

  if (item.available_quantity <= 5) {
    await publish('stock_alert', { id: item.id, title: item.title, stock: item.available_quantity, loja: lojaNome });
    await tgNotify('tg_reposicao', `⚠️ <b>Estoque crítico!</b>\n🏪 Loja: <b>${lojaNome}</b>\n📦 ${item.title}\n🔢 Restam apenas ${item.available_quantity} unidades`);
  }

  const changes = [];
  if (prev) {
    if (String(prev.title) !== String(item.title))                           changes.push({ field: 'title',  old: prev.title,              new: item.title });
    if (Number(prev.price) !== Number(item.price))                           changes.push({ field: 'price',  old: prev.price,              new: item.price });
    if (Number(prev.available_quantity) !== Number(item.available_quantity)) changes.push({ field: 'stock',  old: prev.available_quantity, new: item.available_quantity });
    if (prev.status !== item.status)                                         changes.push({ field: 'status', old: prev.status,             new: item.status });
  } else {
    changes.push({ field: 'criado', old: null, new: item.status });
  }
  if (changes.length) {
    await pool.query(
      `INSERT INTO item_changes (item_id, store_id, changes, changed_at) VALUES ($1,$2,$3,now())`,
      [item.id, storeId, JSON.stringify(changes)]
    );

    // Telegram: notificar alterações relevantes (ignora só stock quando já notificou estoque crítico)
    const fmtR$ = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    const now   = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const fieldEmoji = { title: '✏️ Título', price: '💲 Preço', stock: '📦 Estoque', status: '🔄 Status', criado: '🆕 Novo anúncio' };

    const lines = changes.map(c => {
      const label = fieldEmoji[c.field] || c.field;
      if (c.field === 'criado')  return `${label}: anúncio publicado (status: ${c.new})`;
      if (c.field === 'price')   return `${label}: ${fmtR$(c.old)} → <b>${fmtR$(c.new)}</b>`;
      if (c.field === 'stock')   return `${label}: ${c.old} → <b>${c.new}</b> un.`;
      if (c.field === 'status')  return `${label}: ${c.old} → <b>${c.new}</b>`;
      if (c.field === 'title')   return `${label}:\n  <i>${(c.old||'').slice(0,80)}</i>\n  → <b>${(c.new||'').slice(0,80)}</b>`;
      return `${label}: ${c.old} → ${c.new}`;
    });

    const msg =
      `🏷️ <b>Alteração de Anúncio</b>\n` +
      `🏪 Loja: <b>${lojaNome}</b>\n` +
      `📋 ${(item.title||'').slice(0, 100)}\n` +
      `🕐 ${now}\n\n` +
      lines.join('\n');

    await tgNotify('tg_anuncios', msg);
  }

  await publish('anuncio_updated', { id: item.id, status: item.status });
}

async function handlePostPurchase({ resource, storeId }) {
  const claimId = resource.split('/').pop();
  try {
    const claim = await ml.get(`/post-purchase/claims/${claimId}`, storeId);
    const orderId = claim.order_id || null;
    const buyerNickname = claim.players?.find(p => p.role === 'complainant')?.user_id?.toString() || null;
    const itemTitle = claim.resolution?.description || null;
    await pool.query(
      `INSERT INTO returns (store_id, order_id, buyer_nickname, title, reason, amount, status, date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT DO NOTHING`,
      [storeId, orderId, buyerNickname, itemTitle || claim.reason_id,
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

let recentFailures = 0;
const oauthNotified = new Map(); // storeId → last Telegram notification timestamp

const expiredStores = new Set();

async function processJob(job) {
  const { topic, resource, storeId, logId } = job.data;
  const handler = handlers[topic];

  if (!handler) {
    console.warn(`[worker] no handler for topic=${topic}`);
    return;
  }

  // Drop job imediatamente se token da loja está expirado
  if (expiredStores.has(storeId)) {
    console.warn(`[worker] drop ${topic} store=${storeId} — token expirado`);
    return;
  }
  const { rows: tokenCheck } = await pool.query(
    `SELECT token_expires_at FROM stores WHERE id=$1`, [storeId]
  );
  if (tokenCheck.length && tokenCheck[0].token_expires_at < new Date('2000-01-01')) {
    expiredStores.add(storeId);
    console.warn(`[worker] drop ${topic} store=${storeId} — token expirado (marcado)`);
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
      if (job.attemptsMade < 4) {
        console.warn(`[worker] RATE_LIMITED ${job.name}#${job.id} — attempt ${job.attemptsMade + 1}/5, will retry`);
        throw err;
      }
      console.warn(`[worker] RATE_LIMITED drop ${job.name}#${job.id} — not retrying`);
      return;
    }
    throw err;
  }
}

function attachWorkerEvents(w, label) {
  w.on('error', (err) => console.error(`[worker:${label}] error:`, err.message));
  w.on('completed', (job) => { console.log(`[worker:${label}] done ${job.name}#${job.id}`); recentFailures = 0; });
  w.on('failed', (job, err) => {
    console.error(`[worker:${label}] failed ${job?.name}#${job?.id}`, err.message);
    recentFailures++;
    if (recentFailures === 5) {
      tgNotify('tg_fila', `🚨 <b>Fila BullMQ com erros consecutivos!</b>\n${recentFailures} jobs falharam seguidos.\nVerifique os logs: <code>journalctl -u ml-worker-novo -n 50</code>`).catch(() => {});
    }
  });
}

async function startWorkers() {
  const { rows } = await pool.query('SELECT id FROM stores');

  // Always include a worker for the 'default' queue (storeId unknown)
  const storeIds = ['default', ...rows.map(r => String(r.id))];

  for (const storeId of storeIds) {
    const w = new Worker(`ml-webhooks-${storeId}`, processJob, {
      connection: new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false }),
      concurrency: 1,
      // 20 req/min per store token = 1 req per 3s to stay safely below the limit
      limiter: { max: 1, duration: 5000 },
    });
    attachWorkerEvents(w, storeId);
    console.log(`[worker] started queue ml-webhooks-${storeId}`);
  }

  // Legacy worker — processes jobs still sitting in the old global queue
  const legacyWorker = new Worker('ml-webhooks', processJob, {
    connection: new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false }),
    concurrency: 1,
    limiter: { max: 1, duration: 3000 },
  });
  attachWorkerEvents(legacyWorker, 'legacy');
  console.log('[worker] started legacy queue ml-webhooks');
}

startWorkers().catch(err => {
  console.error('[worker] failed to start workers:', err);
  process.exit(1);
});

// ── Daily reconciliation at 03:00 ────────────────────────────
let isSyncing = false;

async function dailySync() {
  if (isSyncing) { console.warn('[sync] já em execução — ignorando chamada duplicada'); return; }
  isSyncing = true;
  console.log('[sync] iniciando reconciliação diária...');
  const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores`);
  const dateFrom = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  for (const store of stores) {
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

  // Preenche parent_item_id de itens que ainda não têm
  const { rows: missing } = await pool.query(`SELECT COUNT(*) as c FROM items WHERE parent_item_id IS NULL`);
  if (Number(missing[0].c) > 0) {
    console.log(`[sync] iniciando syncParentItems (${missing[0].c} itens sem parent_item_id)...`);
    await syncParentItems().catch(e => console.error('[sync] syncParentItems erro:', e.message));
  }

  isSyncing = false;
  scheduleDailySync();
}

async function syncParentItems() {
  console.log('[syncParentItems] preenchendo parent_item_id via multiget...');
  const { rows: stores } = await pool.query(`SELECT id FROM stores`);
  let updated = 0; let total = 0;

  for (const store of stores) {
    const { rows: items } = await pool.query(
      `SELECT ml_id FROM items WHERE parent_item_id IS NULL AND store_id = $1`,
      [store.id]
    );
    console.log(`[syncParentItems] store=${store.id} → ${items.length} itens`);
    const ids = items.map(r => r.ml_id);

    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      total += batch.length;
      try {
        await new Promise(r => setTimeout(r, 12000));
        const token = await getTokenForStore(store.id);
        const qs = batch.map(id => `ids=${id}`).join('&');
        const res = await fetch(`https://api.mercadolibre.com/items?${qs}&attributes=id,parent_item_id`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const results = Array.isArray(data) ? data : [data];
        for (const entry of results) {
          const body = entry.body || entry;
          if (!body?.id) continue;
          await pool.query(
            `UPDATE items SET parent_item_id = $1 WHERE ml_id = $2`,
            [body.parent_item_id || null, body.id]
          );
          if (body.parent_item_id) updated++;
        }
        console.log(`[syncParentItems] store=${store.id} lote ${i/20+1} ok`);
      } catch (e) {
        console.warn(`[syncParentItems] lote store=${store.id} i=${i}:`, e.message);
        if (e.message?.includes('429')) await new Promise(r => setTimeout(r, 60000));
      }
    }
    await new Promise(r => setTimeout(r, 15000));
  }

  console.log(`[syncParentItems] concluído — ${updated}/${total} com parent_item_id`);
  await tgNotify('tg_infra', `✅ Sync parent_item_id concluído\n📦 ${updated}/${total} itens atualizados`).catch(()=>{});
}

async function getTokenForStore(storeId) {
  const { rows } = await pool.query(`SELECT access_token FROM stores WHERE id=$1`, [storeId]);
  return rows[0]?.access_token;
}

async function syncReturns() {
  console.log('[syncReturns] iniciando busca retroativa de devoluções...');
  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores`);
  let total = 0;

  for (const store of stores) {
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const data = await ml.searchClaims(store.id, offset);
        const claims = data?.data || [];
        if (!claims.length) { hasMore = false; break; }

        for (const c of claims) {
          try {
            await new Promise(r => setTimeout(r, 2000));
            const claim = await ml.getClaim(c.id, store.id);
            const orderId = claim.order_id || null;
            const buyerNickname = claim.players?.find(p => p.role === 'complainant')?.user_id?.toString() || null;
            await pool.query(
              `INSERT INTO returns (store_id, order_id, buyer_nickname, title, reason, amount, status, date, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
               ON CONFLICT DO NOTHING`,
              [store.id, orderId, buyerNickname,
               claim.resolution?.description || claim.reason_id || null,
               claim.reason_id || null, claim.total || 0,
               claim.status, claim.date_created]
            );
            total++;
          } catch (e) {
            console.warn(`[syncReturns] claim=${c.id}:`, e.message);
          }
        }

        offset += 50;
        hasMore = claims.length === 50;
      } catch (e) {
        console.warn(`[syncReturns] store=${store.id} offset=${offset}:`, e.message);
        hasMore = false;
      }
    }
    console.log(`[syncReturns] store=${store.id} concluído`);
  }

  console.log(`[syncReturns] concluído — ${total} devoluções importadas`);
  await tgNotify('tg_devolucoes', `✅ Sync retroativo de devoluções concluído\n📦 ${total} registros importados`).catch(()=>{});
}

// ── Sync Visitas — 02:00 diário, 30s entre lotes, cada loja com seu app ──────
let isSyncingVisitas = false;

async function syncVisitas() {
  if (isSyncingVisitas) { console.warn('[visitas] já em execução — ignorando'); return; }
  isSyncingVisitas = true;
  console.log('[visitas] iniciando coleta de visitas...');

  try {
    const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores`);
    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    for (const store of stores) {
      try {
        const { rows: activeItems } = await pool.query(
          `SELECT ml_id FROM items WHERE store_id=$1 AND status='active' LIMIT 300`, [store.id]
        );
        const ids = activeItems.map(r => r.ml_id);
        console.log(`[visitas] store=${store.nickname} → ${ids.length} anúncios`);

        for (let i = 0; i < ids.length; i++) {
          const itemId = ids[i];
          try {
            const vData = await ml.getItemVisits(itemId, yesterday, store.id);
            const total = (vData?.results || []).reduce((s, d) => s + (d.total || 0), 0);
            await pool.query(
              `INSERT INTO item_visits (store_id, item_id, visits, date)
               VALUES ($1,$2,$3,$4) ON CONFLICT (item_id, date) DO UPDATE SET visits=$3, collected_at=now()`,
              [store.id, itemId, total, yesterday]
            );
            if ((i + 1) % 10 === 0) console.log(`[visitas] store=${store.nickname} ${i+1}/${ids.length} itens`);
          } catch (e) {
            if (e.message?.includes('429') || e.message?.includes('rate limit')) {
              console.warn(`[visitas] 429 detectado — pausando 60s para liberar rate limit`);
              await new Promise(r => setTimeout(r, 60000));
            } else {
              console.warn(`[visitas] store=${store.nickname} item=${itemId}: ${e.message}`);
            }
          }
          await new Promise(r => setTimeout(r, 20000)); // 20s por item = 3 req/min, usa janela de 50min
        }
        await new Promise(r => setTimeout(r, 5000)); // 5s entre lojas
      } catch (e) {
        console.warn(`[visitas] store=${store.nickname} erro:`, e.message);
      }
    }
    console.log('[visitas] coleta concluída');
  } finally {
    isSyncingVisitas = false;
    scheduleVisitasSync();
  }
}

function scheduleVisitasSync() {
  const now   = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const ms = next2am - now;
  console.log(`[visitas] próxima coleta: ${next2am.toLocaleString('pt-BR')} (em ${Math.round(ms/60000)}min)`);
  setTimeout(syncVisitas, ms);
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

// Verifica e renova tokens a cada 5 horas (independente do dailySync das 03:00)
async function tokenRefreshLoop() {
  console.log('[token-loop] verificando tokens...');
  try {
    const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores`);
    for (const store of stores) {
      const expiresIn = store.token_expires_at ? (new Date(store.token_expires_at) - Date.now()) : -1;

      // Se token está válido com mais de 3h, limpa do Set de expirados (reconexão manual)
      if (expiresIn >= 3 * 60 * 60 * 1000) {
        if (expiredStores.has(store.id)) {
          expiredStores.delete(store.id);
          console.log(`[token-loop] token válido após reconexão: ${store.nickname}`);
        }
        continue;
      }

      // Renova se faltar menos de 3h ou já expirado — 3h dá margem para o loop de 1h
      if (expiresIn < 3 * 60 * 60 * 1000) {
        try {
          await refreshToken(store.id);
          expiredStores.delete(store.id);
          console.log(`[token-loop] token renovado: ${store.nickname}`);
          if (expiresIn < 0) {
            await tgNotify('tg_token', `✅ <b>Token renovado automaticamente!</b>\n🏪 Loja: ${store.nickname}`);
          }
        } catch (e) {
          console.warn(`[token-loop] refresh falhou ${store.nickname}:`, e.message);
          await tgNotify('tg_token', `🔴 <b>Token expirado — refresh falhou!</b>\n🏪 Loja: ${store.nickname}\nAcesse: /auth/login?store_id=${store.id}\n❌ ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 15000)); // 15s entre lojas para não bater rate limit OAuth
      } else if (expiresIn < 48 * 60 * 60 * 1000) {
        const horas = Math.floor(expiresIn / 3600000);
        if (horas % 6 === 0) { // alerta só 1x a cada 6h para não encher o Telegram
          await tgNotify('tg_token', `⚠️ <b>Token expira em ${horas}h</b>\n🏪 Loja: ${store.nickname}`);
        }
      }
    }
  } catch (e) {
    console.error('[token-loop] erro:', e.message);
  }
  setTimeout(tokenRefreshLoop, 60 * 60 * 1000); // verifica a cada 1h (antes era 5h)
}

scheduleDailySync();
scheduleVisitasSync();
tokenRefreshLoop(); // inicia imediatamente e repete a cada 5h

// Ao iniciar o worker, roda dailySync após 2 min SOMENTE fora do horário de pico (22h–08h)
setTimeout(() => {
  const h = new Date().getHours();
  if (h >= 22 || h < 8) {
    console.log('[worker] sync inicial automático (fora do pico)');
    dailySync().catch(e => console.error('[worker] sync inicial erro:', e.message));
  } else {
    console.log(`[worker] sync inicial ignorado — horário de pico (${h}h). Aguardando 03:00.`);
  }
}, 2 * 60 * 1000);

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
    if (cmd === 'syncReturns') {
      console.log('[worker] syncReturns disparado manualmente');
      syncReturns().catch(e => console.error('[worker] syncReturns erro:', e.message));
    }
    if (cmd === 'syncParentItems') {
      console.log('[worker] syncParentItems disparado manualmente');
      syncParentItems().catch(e => console.error('[worker] syncParentItems erro:', e.message));
    }
    if (cmd === 'syncVisitas') {
      console.log('[worker] syncVisitas disparado manualmente');
      syncVisitas().catch(e => console.error('[worker] syncVisitas erro:', e.message));
    }
  } catch {}
});

console.log('[worker] listening for ml-webhooks jobs...');
