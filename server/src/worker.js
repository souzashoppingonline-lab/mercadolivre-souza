// BullMQ Worker — consumes jobs enqueued by the Webhook Gateway, fetches ONLY
// the changed resource from the Mercado Livre API, writes it to PostgreSQL,
// refreshes the relevant Redis cache keys, and pushes a WebSocket update.
//
// Run as its own process: `npm run worker`
require('dotenv').config();
const fsp = require('fs/promises');
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const pool = require('./db/pool');
const redis = require('./db/redis');
const ml = require('./mlClient');
const financeService = require('./financeService');
const { packageDimsFromItem } = require('./mlDims');
const ranking = require('./ranking');
const { fetchAndSaveCatalogCompetition } = require('./catalogCompetition');
const { publish } = require('./ws/hub');
const { refreshToken } = require('./routes/auth');
const { getResumoDiarioData, getTopVendas, getResumoSemanal, getOutliersOntem, getMargemPorLoja, getRupturaEstoque } = require('./reports');
const taskEngine = require('./taskEngine');
const { computeSeoScore } = require('./seoScore');
const { syncMpAccountReports, backfillMpReports } = require('./mpReports');
const { extrairCustosVendedor } = require('./shipmentCosts');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false });
connection.on('error', (err) => console.error('[worker] redis connection error:', err.message));

process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — process will exit:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — process will exit:', err);
});

// ── Logística label ──────────────────────────────────────
function fmtLogistica(raw) {
  const l = (raw || '').toLowerCase();
  if (l.includes('fulfillment'))  return '📦 Full';
  if (l.includes('self_service')) return '🏃 Flex';
  if (l.includes('flex'))         return '🏃 Flex';
  if (l.includes('xd_drop_off'))  return '📮 Mercado Envios';
  if (l.includes('me2'))          return '📮 Mercado Envios';
  if (l.includes('me1'))          return '📮 Mercado Envios';
  if (l.includes('cross_docking'))return '📮 Mercado Envios';
  if (l.includes('pickup'))       return '🏠 Coleta';
  return raw || '—';
}

// ── Telegram notification helper ─────────────────────────
// Extraído para server/src/notify.js pra ser compartilhado com o
// marketplaceEventWorker (vendas Amazon/Shopee) — mesma lógica de
// token/chat/silêncio/throttle, sem duplicar.
const { tgNotify, tgNotifyForce } = require('./notify');
const { upsertClaim } = require('./claims');

const noop = () => {};  // topics we receive but don't need to process

// Cache de nicknames para evitar query ao Postgres a cada webhook
const _nicknameCache = new Map(); // storeId → { name, expiresAt }
async function getStoreName(storeId) {
  const cached = _nicknameCache.get(storeId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  const { rows } = await pool.query(`SELECT nickname FROM stores WHERE id=$1`, [storeId]);
  const name = rows[0]?.nickname || `Loja ${storeId}`;
  _nicknameCache.set(storeId, { name, expiresAt: Date.now() + 10 * 60 * 1000 });
  return name;
}

// Status de Entrega (Conciliação Bancária) — busca o shipment real e persiste
// status/substatus/datas em `orders`. Casa pelo shipping_id já persistido por
// handleOrder (não por raw_data->>'shipment_id' — mecanismo antigo e
// inconsistente, ver decisions.md). Se o pedido ainda não existe localmente
// (orders_v2 chegou depois), a UPDATE não afeta linhas e é ignorada — o
// próximo webhook de shipment ou o job `sync-shipping-status` (a cada 4h)
// resolve. Esse job também é o que garante que o status avança quando o ML
// não reenvia um webhook novo a cada transição (ver decisions.md).
async function handleShipment({ resource, storeId }) {
  const shipmentId = resource.split('/').pop();
  const ship = await ml.getShipment(shipmentId, storeId);
  const sh = ship?.status_history || {};

  // Frete do vendedor em tempo real: /shipments/:id/costs → senders[].cost (o
  // que o vendedor paga) e senders[].save+compensation (o que o ML devolve/
  // credita ao vendedor — ver shipmentCosts.js). Grava como fallback em
  // orders.shipping_seller_cost/shipping_seller_reembolso; a Conciliação MP
  // das 05:40 continua sendo a fonte oficial pra tarifa e sobrepõe na
  // leitura. Alguns tipos de logística (ex: coleta/flex) podem não expor
  // custos — nesse caso deixa as colunas intactas.
  let sellerCost = null, sellerReembolso = 0;
  try {
    const costs = await ml.getShipmentCosts(shipmentId, storeId);
    ({ sellerCost, sellerReembolso } = extrairCustosVendedor(costs));
  } catch (e) {
    // 404/403 em alguns envios — não é erro fatal, só não temos o custo em tempo real
  }

  const { rows } = await pool.query(
    `UPDATE orders SET
       shipping_status = $1,
       shipping_substatus = $2,
       date_ready_to_ship = $3,
       date_shipped = $4,
       date_delivered = $5,
       shipping_last_updated = $6,
       shipping_seller_cost = COALESCE($9, shipping_seller_cost),
       shipping_seller_reembolso = COALESCE($10, shipping_seller_reembolso),
       updated_at = now()
     WHERE store_id = $7 AND shipping_id = $8
     RETURNING ml_id`,
    [
      ship?.status || null,
      ship?.substatus || null,
      sh.date_ready_to_ship || null,
      sh.date_shipped || null,
      sh.date_delivered || null,
      ship?.last_updated || null,
      storeId,
      String(shipmentId),
      sellerCost,
      sellerCost != null ? sellerReembolso : null, // só atualiza reembolso junto de um custo confirmado
    ]
  );
  if (!rows.length) return;
  await publish('order_updated', { order_id: rows[0].ml_id, shipping_status: ship?.status });
}

const handlers = {
  orders_v2:         handleOrder,
  payments:          handlePayment,
  questions:         handleQuestion,
  messages:          handleMessage,
  items:             handleItem,
  public_offers:     handleOffer,
  post_purchase:     handlePostPurchase,
  items_prices:      handleItemPrice,
  shipments:         handleShipment,
  invoices:          noop,
  public_candidates: noop,
  'stock-locations': noop,
  // v88 — Buy-Box em tempo real (ver .claude/rankeamento.md e mercadolivre.md).
  // Só dispara de verdade se o tópico estiver habilitado no painel de
  // desenvolvedor do ML pra este app; sem isso o ML nunca manda o webhook e
  // este handler nunca roda — o job diário sync-catalog-competition continua
  // cobrindo tudo normalmente, sem regressão.
  catalog_item_competition_status: handleCatalogCompetitionStatus,
};

// payments webhook: /collections/{paymentId} → busca order_id e reprocessa o pedido
async function handlePayment({ resource, storeId }) {
  const paymentId = resource.split('/').pop();
  try {
    const payment = await ml.getPayment(paymentId, storeId);
    const orderId = payment?.collection?.order?.id || payment?.order?.id || payment?.order_id;
    if (!orderId) { console.warn(`[payments] payment=${paymentId} sem order_id`); return; }
    // handleOrder primeiro — garante que orders.ml_id já existe antes do INSERT
    // abaixo (ml_payments.order_id tem FK pra orders.ml_id).
    await handleOrder({ resource: `/orders/${orderId}`, storeId });

    // Conciliação Bancária (Fase 1, só dados novos a partir de agora — ver
    // decisions.md): persiste o retorno de /collections/:id, que antes era
    // descartado depois de extrair o order_id. Confirmado ao vivo (18/07/2026)
    // que esse endpoint já traz money_release_date/net_received_amount/released
    // e detalhamento de taxas, sem precisar de credencial Mercado Pago separada
    // — ver decisions.md. Extração defensiva (múltiplos caminhos possíveis)
    // porque o formato exato de /collections/:id não é documentado publicamente.
    // raw_data grava a resposta completa, então nada se perde mesmo se algum
    // campo vier de um caminho diferente do esperado.
    const c = payment?.collection || payment;
    await pool.query(
      `INSERT INTO ml_payments (
         payment_id, order_id, store_id, status, status_detail, transaction_amount,
         date_created, date_approved, net_received_amount, money_release_date, released,
         marketplace_fee, mercadopago_fee, discount_fee, coupon_fee, finance_fee,
         amount_refunded, shipping_cost, payment_method_id, payment_type, installments,
         raw_data, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (payment_id) DO UPDATE SET
         order_id = EXCLUDED.order_id,
         status = EXCLUDED.status,
         status_detail = EXCLUDED.status_detail,
         transaction_amount = EXCLUDED.transaction_amount,
         date_approved = EXCLUDED.date_approved,
         net_received_amount = EXCLUDED.net_received_amount,
         money_release_date = EXCLUDED.money_release_date,
         released = EXCLUDED.released,
         marketplace_fee = EXCLUDED.marketplace_fee,
         mercadopago_fee = EXCLUDED.mercadopago_fee,
         discount_fee = EXCLUDED.discount_fee,
         coupon_fee = EXCLUDED.coupon_fee,
         finance_fee = EXCLUDED.finance_fee,
         amount_refunded = EXCLUDED.amount_refunded,
         shipping_cost = EXCLUDED.shipping_cost,
         payment_method_id = EXCLUDED.payment_method_id,
         payment_type = EXCLUDED.payment_type,
         installments = EXCLUDED.installments,
         raw_data = EXCLUDED.raw_data,
         updated_at = now()`,
      [
        c?.id || paymentId,
        String(orderId),
        storeId,
        c?.status || null,
        c?.status_detail || null,
        c?.transaction_amount || null,
        c?.date_created || null,
        c?.date_approved || null,
        c?.net_received_amount ?? null,
        c?.money_release_date || null,
        c?.released ?? null,
        c?.marketplace_fee ?? null,
        c?.mercadopago_fee ?? null,
        c?.discount_fee ?? null,
        c?.coupon_fee ?? null,
        c?.finance_fee ?? null,
        c?.amount_refunded ?? null,
        c?.shipping_cost ?? null,
        c?.payment_method_id || null,
        c?.payment_type || null,
        c?.installments ?? null,
        JSON.stringify(payment),
      ]
    ).catch(e => console.warn(`[payments] ml_payments insert falhou payment=${paymentId}: ${e.message}`));
  } catch(e) {
    console.warn(`[payments] payment=${paymentId}: ${e.message}`);
  }
}

async function handleOrder({ resource, storeId, silent = false }) {
  const orderId = resource.split('/').pop();

  // Skip duplicate — evita chamar ML API duas vezes para o mesmo pedido em 30 min,
  // MAS permite processar novamente se o pedido ainda não está como 'paid'
  // (a confirmação de pagamento chega minutos depois e não deve ser bloqueada pelo dedup)
  const recent = await pool.query(
    `SELECT ml_id, status FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '30 minutes'`, [orderId]
  );
  if (recent.rows.length && recent.rows[0].status === 'paid') return;

  const order = await ml.getOrder(orderId, storeId);

  // Status anterior (antes deste upsert) — usado para só notificar "Nova venda!"
  // na transição real para 'paid', e não em todo webhook tardio (ex: shipments)
  // que chega para um pedido que já estava pago.
  const { rows: prevRows } = await pool.query(`SELECT status, shipping_type FROM orders WHERE ml_id=$1`, [orderId]);
  const previousStatus = prevRows[0]?.status || null;

  const item0 = order.order_items?.[0] || {};

  // A resposta de /orders/:id do ML quase nunca traz shipping.logistic_type
  // preenchido — só vem buscando /shipments/:id separadamente. Sem persistir
  // o valor resolvido aqui, orders.shipping_type ficava em branco pra maioria
  // dos pedidos (só a notificação "Nova venda!" resolvia isso, de forma
  // efêmera, sem gravar no banco — daí o gráfico "Por Logística" mostrar só
  // "Desconhecido"). Guarda: só busca /shipments/:id se ainda não sabemos a
  // logística deste pedido (nem no payload atual, nem já persistida antes) —
  // evita 1 chamada extra à API por webhook já resolvido.
  let shippingType = order.shipping?.logistic_type || prevRows[0]?.shipping_type || '';
  if (!shippingType && order.shipping?.id) {
    try {
      const ship = await ml.getShipment(order.shipping.id, storeId);
      shippingType = ship?.logistic_type || ship?.shipping_option?.logistic_type || '';
    } catch (e) { /* ignora — próximo webhook/reconciliação tenta de novo */ }
  }

  await pool.query(
    `INSERT INTO orders (ml_id, store_id, buyer_nickname, item_id, title, total_amount, quantity, unit_price, ml_fee, shipping_type, shipping_cost, status, date_created, date_closed, raw_data, shipping_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
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
       shipping_id = COALESCE(EXCLUDED.shipping_id, orders.shipping_id),
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
      order.shipping?.id ? String(order.shipping.id) : null,
    ]
  );

  await redis.del(`kpis:${storeId}`);
  await redis.del('kpis:summary');
  await publish('order_updated', { id: order.id, status: order.status });

  // Só é "Nova venda!" na transição real para 'paid' — evita reenviar o alerta
  // quando um webhook tardio (shipments, payments) reprocessa um pedido que já estava pago.
  const saleDate = order.date_closed || order.date_created;
  const saleAgeMs = saleDate ? Date.now() - new Date(saleDate).getTime() : 0;
  // Guarda extra: mesmo sendo a 1ª vez que este pedido aparece no nosso banco
  // (ex: pedido nunca importado, e hoje chegou um webhook de shipments/claims
  // referenciando-o), só é "tempo real" se a venda em si aconteceu há pouco.
  // Tolerância generosa (24h) cobre atraso de fila/rate-limit e boleto compensando.
  const isRecentEnough = saleAgeMs < 24 * 60 * 60 * 1000;
  const isNewSale = order.status === 'paid' && previousStatus !== 'paid' && isRecentEnough;
  if (order.status === 'paid' && previousStatus !== 'paid' && !isRecentEnough) {
    console.log(`[worker] venda antiga ignorada no Telegram: order=${order.id} date_closed=${order.date_closed} idade=${Math.round(saleAgeMs/3600000)}h`);
  }
  if (isNewSale) {
    const val = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(order.total_amount)||0);
    const loja = await getStoreName(storeId);
    const envioLabel = fmtLogistica(shippingType);
    const fmtDataHora = d => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });
    const saleDateFmt = saleDate ? fmtDataHora(saleDate) : fmtDataHora(new Date());
    const notifiedAtFmt = fmtDataHora(new Date());
    if (!silent) {
      await tgNotify('tg_vendas', `🛒 <b>Nova venda!</b>\n🏪 ${loja}\n📦 ${item0.item?.title||'—'}\n💰 ${val}\n🚚 ${envioLabel}\n👤 ${order.buyer?.nickname||'—'}\n🕐 Venda: ${saleDateFmt}\n📨 Notificado: ${notifiedAtFmt}`);
      // Alerta em tempo real na tela do dashboard (som + push) — consumido por
      // js/layout.js (WS.on('nova_venda')). Mesma guarda anti-pedido-antigo do
      // Telegram, então nunca dispara em importação em massa (silent) nem venda >24h.
      await publish('nova_venda', {
        marketplace: 'ML',
        loja,
        titulo: item0.item?.title || '—',
        valor: val,
        comprador: order.buyer?.nickname || '—',
        order_id: order.id,
      });
    }
  }

  // Rankeamento: registra a venda de qualquer item monitorado deste pedido PAGO.
  // Roda FORA do gate isNewSale/!silent de propósito: o onSale é idempotente por
  // order_id (não conta 2x) e só conta vendas a partir do started_at do anúncio,
  // então pode rodar em silent / re-sync / venda >24h sem inflar nem duplicar —
  // é isso que garante que nenhuma venda de anúncio em rankeamento seja perdida.
  // Telegram só quando é venda em tempo real (isNewSale && !silent). Best-effort.
  if (order.status === 'paid') {
    const realtime = isNewSale && !silent;
    for (const oi of (order.order_items || [])) {
      const mlId = oi.item?.id;
      if (!mlId) continue;
      try {
        await ranking.onSale({
          mlId, order,
          valorNum: Number(oi.unit_price || 0) * Number(oi.quantity || 1),
          comprador: order.buyer?.nickname || '—',
          saleDate, realtime,
        });
      } catch (e) { console.error('[ranking] onSale falhou:', e.message); }
    }
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
    const loja = await getStoreName(storeId);
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
  const text = msg.text || msg.message || msg.message_text || null;
  const msgDate = msg.message_date?.received || msg.message_date?.created || null;
  console.log(`[msg-debug] msgId=${msgId} keys=${Object.keys(msg||{}).join(',')} full=${JSON.stringify(msg).slice(0, 900)}`);

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

  await publish('message_received', { pack_id: packId, buyer_nickname: buyerNickname });
  const loja = await getStoreName(storeId);
  const dashUrl = (process.env.DASH_URL || 'https://multimixvendas.duckdns.org') + '/pages/mensagens.html';
  await tgNotify('tg_mensagens',
    `💬 <b>Nova mensagem de comprador</b>\n🏪 Loja: ${loja}\n👤 ${buyerNickname||'—'}\n📝 ${(text||'—').slice(0,300)}\n<a href="${dashUrl}">Abrir mensagens →</a>`);
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
  const origPrice = item.original_price && Number(item.original_price) > 0 ? item.original_price : null;
  // Medidas da caixa (cacheadas pra a Embalagem ler do banco, sem GET no bipe).
  const dims = packageDimsFromItem(item);
  await pool.query(
    `INSERT INTO items (ml_id, store_id, title, price, original_price, available_quantity, sold_quantity, status, category_id, thumbnail, permalink, parent_item_id, package_dims, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       title = EXCLUDED.title, price = EXCLUDED.price,
       original_price = COALESCE(EXCLUDED.original_price, items.original_price),
       available_quantity = EXCLUDED.available_quantity,
       sold_quantity = EXCLUDED.sold_quantity,
       status = EXCLUDED.status,
       thumbnail = COALESCE(EXCLUDED.thumbnail, items.thumbnail),
       permalink = COALESCE(EXCLUDED.permalink, items.permalink),
       parent_item_id = COALESCE(EXCLUDED.parent_item_id, items.parent_item_id),
       package_dims = COALESCE(EXCLUDED.package_dims, items.package_dims),
       updated_at = now()`,
    [item.id, storeId, item.title, item.price, origPrice, item.available_quantity, item.sold_quantity, item.status, item.category_id, thumb, item.permalink || null, parentId, dims ? JSON.stringify(dims) : null]
  );

  // Rankeamento: se este anúncio está em rankeamento, notifica preço/estoque/status
  // alterados (tela + Telegram). Zero custo de API — usa o item já buscado.
  try {
    await ranking.onItemChange({
      mlId: item.id, price: item.price, availableQuantity: item.available_quantity,
      status: item.status, title: item.title,
    });
  } catch (e) { console.error('[ranking] onItemChange falhou:', e.message); }

  const lojaNome = await getStoreName(storeId);

  if (item.available_quantity <= 5) {
    await publish('stock_alert', { id: item.id, title: item.title, stock: item.available_quantity, loja: lojaNome });
    await tgNotify('tg_reposicao', `⚠️ <b>Estoque crítico!</b>\n🏪 Loja: <b>${lojaNome}</b>\n📦 ${item.title}\n🔢 Restam apenas ${item.available_quantity} unidades`);
  }
  const stockTask = await taskEngine.checkStock({
    itemId: item.id, title: item.title, availableQuantity: item.available_quantity,
    permalink: item.permalink, storeId, storeName: lojaNome,
  });
  if (stockTask?.created) await publish('task_created', { id: stockTask.id, rule_key: 'estoque_critico', title: 'Repor estoque urgente' });

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

// Claim detail (GET /post-purchase/v1/claims/:id) não tem campo order_id —
// confirmado testando ao vivo contra a API real. O pedido é claim.resource_id
// quando claim.resource === 'order' (o caso de praticamente toda devolução;
// outros valores de resource, ex. envio, não têm pedido associado, orderId
// fica null mesmo). Ver .claude/decisions.md.
function claimOrderId(claim) {
  return claim.resource === 'order' && claim.resource_id != null ? String(claim.resource_id) : (claim.order_id || null);
}

// A claim de detalhe do ML não tem campo de valor monetário (claim.total não
// existe — testado ao vivo, ver decisions.md), então "valor da devolução" usa
// o total_amount do pedido associado, já sincronizado via webhook orders_v2 —
// consulta só o Postgres, nenhuma chamada extra à API do ML.
async function resolveReturnAmount(orderId) {
  if (!orderId) return 0;
  const { rows } = await pool.query('SELECT total_amount FROM orders WHERE ml_id = $1', [orderId]);
  return Number(rows[0]?.total_amount) || 0;
}

// Traduz reason_id ("PNR9509") pra descrição em português ("Me arrependi da
// compra") via /marketplace/v2/claims/reasons/:id — cacheado em
// claim_reasons pra nunca rechamar a API pro mesmo código (rate limit real
// observado testando isso ao vivo). Chamado só aqui, no worker — nunca em
// rota de leitura (regra 3 de architecture.md).
async function resolveClaimReason(reasonId, storeId) {
  if (!reasonId) return null;
  const { rows } = await pool.query('SELECT detail FROM claim_reasons WHERE id = $1', [reasonId]);
  if (rows.length) return rows[0].detail;
  try {
    const data = await ml.getClaimReason(reasonId, storeId);
    await pool.query(
      `INSERT INTO claim_reasons (id, detail, flow, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO UPDATE SET detail = EXCLUDED.detail, flow = EXCLUDED.flow, updated_at = now()`,
      [reasonId, data.detail || null, data.flow || null]
    );
    return data.detail || null;
  } catch (e) {
    console.warn(`[worker] resolveClaimReason(${reasonId})`, e.message);
    return null;
  }
}

async function handlePostPurchase({ resource, storeId }) {
  const claimId = resource.split('/').pop();
  try {
    const claim = await ml.getClaim(claimId, storeId);
    const orderId = claimOrderId(claim);
    const buyerNickname = claim.players?.find(p => p.role === 'complainant')?.user_id?.toString() || null;
    const itemTitle = claim.resolution?.description || null;
    const reasonText = await resolveClaimReason(claim.reason_id, storeId);
    const amount = await resolveReturnAmount(orderId);
    // Upsert por claim_id — nunca cria linha duplicada; registra a transição
    // no histórico. Ver server/src/claims.js e .claude/decisions.md.
    const up = await upsertClaim({ storeId, orderId, buyerNickname, amount, claim });
    await publish('devolucao_recebida', { store_id: storeId, claim_id: claimId, status: claim.status });
    // Notifica "nova devolução" só quando é reclamação nova (ou reabriu) e está
    // aberta — evita re-notificar a cada webhook de atualização da mesma claim.
    if (claim.status === 'opened' && (up.isNew || up.statusChanged)) {
      const loja = await getStoreName(storeId);
      const { rows: od } = await pool.query(
        `SELECT o.title, o.item_id, i.permalink
           FROM orders o LEFT JOIN items i ON i.ml_id = o.item_id
          WHERE o.ml_id = $1`, [orderId]
      );
      const prod = od[0]?.title || itemTitle || '—';
      const anuncio = od[0]?.item_id
        ? (od[0].permalink ? `<a href="${od[0].permalink}">${od[0].item_id}</a>` : od[0].item_id)
        : '—';
      const motivo = reasonText ? `${reasonText} (${claim.reason_id})` : (claim.reason_id || '—');
      await tgNotify('tg_devolucoes',
        `🔄 <b>Nova devolução solicitada</b>\n🏪 Loja: ${loja}\n📦 Pedido: ${orderId||'—'}\n🏷️ Produto: ${prod}\n🔗 Anúncio: ${anuncio}\n💬 Motivo: ${motivo}\n💰 Valor: R$ ${Number(amount||0).toFixed(2)}`);
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

// v88 — Buy-Box em tempo real. Delega pra ranking.onCatalogCompetitionUpdate
// (mesma fetchAndSaveCatalogCompetition do job diário + notificação buybox
// se o item estiver tracked — nunca uma 2ª fórmula). Formato do `resource`
// não confirmado ao vivo (tópico ainda não habilitado no painel do ML pra
// este app) — tenta achar um MLB... em qualquer segmento do path, com
// fallback pro último segmento (mesmo padrão defensivo de handleOffer).
async function handleCatalogCompetitionStatus({ resource, storeId }) {
  const itemId = resource.split('/').find(seg => /^MLB\d+$/i.test(seg)) || resource.split('/').pop();
  if (!itemId) return;
  await ranking.onCatalogCompetitionUpdate(itemId, storeId);
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

  // Get current price + estoque/link/vendas from local DB — zero extra API calls
  let availableQty = null, permalink = null, sold30d = 0;
  if (itemId) {
    const itemRow = await pool.query(
      `SELECT price, available_quantity, permalink FROM items WHERE ml_id=$1 LIMIT 1`, [itemId]
    );
    promoPrice   = Number(itemRow.rows[0]?.price || 0);
    availableQty = itemRow.rows[0]?.available_quantity ?? null;
    permalink    = itemRow.rows[0]?.permalink || null;

    // Use price_history to get the pre-promo (original) price
    const histRow = await pool.query(
      `SELECT old_price FROM price_history WHERE item_id=$1 ORDER BY changed_at DESC LIMIT 1`, [itemId]
    );
    originalPrice = Number(histRow.rows[0]?.old_price || promoPrice);

    // Unidades vendidas nos últimos 30 dias (mostra se o item gira) — 1 query barata.
    const soldRow = await pool.query(
      `SELECT COALESCE(SUM(quantity),0) q FROM orders
       WHERE item_id=$1 AND status<>'cancelled' AND date_created >= now() - INTERVAL '30 days'`,
      [itemId]
    );
    sold30d = Number(soldRow.rows[0]?.q || 0);
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

  // Buscar nome da loja pra incluir no alerta
  const { rows: storeRows } = await pool.query(`SELECT nickname FROM stores WHERE id=$1`, [storeId]);
  const storeName = storeRows[0]?.nickname || `Loja ${storeId}`;
  const storeLabel = `\n🏪 <i>${storeName}</i>`;

  // Linha de preço: "de → por (X% off)" quando há preço original maior; senão só o preço.
  const priceLine = (originalPrice > promoPrice && promoPrice > 0)
    ? `💰 ${Rfmt(originalPrice)} → ${Rfmt(promoPrice)}${discountPct > 0 ? `  (${discountPct.toFixed(0)}% off)` : ''}`
    : `💰 ${Rfmt(promoPrice)}`;

  // Linha de estoque + vendas 30d (só as partes que existem).
  const estoqueParts = [];
  if (availableQty != null) estoqueParts.push(`Estoque: ${availableQty} un`);
  if (sold30d > 0) estoqueParts.push(`vendeu ${sold30d} em 30d`);
  const estoqueLine = estoqueParts.length ? `\n📦 ${estoqueParts.join(' · ')}` : '';

  // Link clicável do anúncio (permalink já está no banco).
  const linkLine = permalink ? `\n🔗 <a href="${permalink}">Ver anúncio</a>` : '';

  if (previousStatus === 'active' && currentStatus !== 'active') {
    await tgNotify('tg_promocoes', `🔴 <b>Saiu da promoção!</b>\n📦 ${itemTitle || itemId}\n💰 Preço voltou para ${Rfmt(originalPrice)}\n⚠️ Reative a promoção${estoqueLine}${storeLabel}${linkLine}`);
  } else if (!previousStatus || (previousStatus !== 'active' && currentStatus === 'active')) {
    await tgNotify('tg_promocoes', `🟢 <b>Entrou em promoção!</b>\n📦 ${itemTitle || itemId}\n${priceLine}${estoqueLine}${storeLabel}${linkLine}`);
  } else {
    await tgNotify('tg_promocoes', `🏷️ <b>Promoção alterada</b>\n📦 ${itemTitle || itemId}\n${priceLine}${estoqueLine}${storeLabel}${linkLine}`);
  }
}

let recentFailures = 0;
const oauthNotified  = new Map(); // storeId → last Telegram notification timestamp
const apiCooldown    = new Map(); // `${topic}:${storeId}` → release timestamp (ms)
const rl429Counter   = new Map(); // storeId → { count, windowStart }
const rl429Notified  = new Map(); // storeId → last notification timestamp

const RL_WINDOW_MS   = 10 * 60 * 1000; // janela de 10 minutos
const RL_THRESHOLD   = 3;               // alerta após 3 cooldowns na janela

function track429(storeId, nickname) {
  const now = Date.now();
  const entry = rl429Counter.get(storeId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RL_WINDOW_MS) {
    entry.count = 0; entry.windowStart = now; // reset janela
  }
  entry.count++;
  rl429Counter.set(storeId, entry);

  if (entry.count >= RL_THRESHOLD) {
    const lastNotif = rl429Notified.get(storeId) || 0;
    if (now - lastNotif > RL_WINDOW_MS) {
      rl429Notified.set(storeId, now);
      tgNotify('tg_429',
        `🚦 <b>Rate limit frequente!</b>\n` +
        `🏪 ${nickname}\n` +
        `⚠️ <b>${entry.count} cooldowns de 429</b> nos últimos 10 min\n` +
        `O worker está pausando chamadas por 5 min a cada ocorrência.\n` +
        `Se persistir, verifique o volume de webhooks ou aumente o intervalo de sync.`
      ).catch(() => {});
      entry.count = 0; // reset após notificar
    }
  }
}

const expiredStores = new Set();

async function processJob(job) {
  const { topic, resource, storeId, logId } = job.data;
  const handler = handlers[topic];
  const t0 = Date.now();

  if (!handler) {
    console.log(`[worker] tópico sem handler: ${topic} | store=${storeId}`);
    return;
  }

  // Valida token no DB antes de processar
  const { rows: tokenCheck } = await pool.query(
    `SELECT token_expires_at, nickname FROM stores WHERE id=$1`, [storeId]
  );
  const store = tokenCheck[0];
  const nickname = store?.nickname || storeId;
  const tokenExpAt = store?.token_expires_at;
  const tokenValid = tokenExpAt && tokenExpAt > new Date('2000-01-01');

  if (tokenValid) {
    if (expiredStores.has(storeId)) {
      expiredStores.delete(storeId);
      console.log(`[worker] ✅ token revalidado — ${nickname} (${storeId})`);
    }
  } else {
    expiredStores.add(storeId);
    console.warn(`[worker] ⏭ drop ${topic} — ${nickname} (${storeId}) token expirado`);
    return;
  }

  const cooldownKey = `${topic}:${storeId}`;
  const cooldownUntil = apiCooldown.get(cooldownKey) || 0;
  if (Date.now() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    console.warn(`[worker] ⏭ cooldown ativo — ${nickname} | ${topic} | faltam ${remaining}s`);
    await pool.query(`UPDATE webhook_logs SET status='skipped', processed_at=now() WHERE id=$1`, [logId]);
    return;
  }

  try {
    await handler({ resource, storeId });
    const ms = Date.now() - t0;
    await pool.query(`UPDATE webhook_logs SET status='processed', processed_at=now() WHERE id=$1`, [logId]);
    console.log(`[worker] ✅ ${topic} | ${nickname} | ${resource.split('/').slice(-2).join('/')} | ${ms}ms`);
  } catch (err) {
    const ms = Date.now() - t0;
    await pool.query(`UPDATE webhook_logs SET status='failed', error=$2, processed_at=now() WHERE id=$1`, [logId, err.message]);

    if (err.permanent || err.message?.includes('TOKEN_INVALID')) {
      console.error(`[worker] ❌ TOKEN_INVALID — ${nickname} (${storeId}) | ${err.message.slice(0, 120)}`);
      tgNotify('tg_token', `⚠️ <b>Token inválido</b>\n🏪 ${nickname}\nReconecte em: /lojas`).catch(() => {});
      return;
    }
    if (err.message?.includes('OAUTH_RATE_LIMITED')) {
      const now = Date.now();
      const lastNotified = oauthNotified.get(storeId) || 0;
      console.warn(`[worker] 🔐 OAUTH_RATE_LIMITED — ${nickname} (${storeId})`);
      if (now - lastNotified > 60 * 60 * 1000) {
        oauthNotified.set(storeId, now);
        tgNotify('tg_429', `🔐 <b>OAuth rate limit</b>\n🏪 ${nickname}\nAguardando cooldown. Se persistir após 1h: reconecte em /lojas`).catch(() => {});
      }
      return;
    }
    if (err.message?.includes('em cooldown de rate limit')) {
      // Circuit breaker do mlClient já está segurando esta loja — NÃO é uma
      // chamada nova ao ML, é o gate local (não gasta cota). Retry silencioso
      // (sem poluir o log com "tentativa"); ao esgotar, cai no cooldown de
      // tópico de 5min e vira 'skipped' (reprocessSkipped recupera orders_v2).
      if (job.attemptsMade < 4) throw err;
      apiCooldown.set(cooldownKey, Date.now() + 5 * 60 * 1000);
      await pool.query(`UPDATE webhook_logs SET status='skipped', processed_at=now() WHERE id=$1`, [logId]);
      return;
    }
    if (err.message?.includes('429')) {
      if (job.attemptsMade < 4) {
        console.warn(`[worker] ⏳ rate limit — ${nickname} | ${topic} | tentativa ${job.attemptsMade + 1}/5`);
        throw err;
      }
      console.warn(`[worker] ⏭ rate limit drop — ${nickname} | ${topic} | esgotou retries — cooldown 5min`);
      apiCooldown.set(cooldownKey, Date.now() + 5 * 60 * 1000);
      track429(storeId, nickname);
      return;
    }
    console.error(`[worker] ❌ erro ${topic} | ${nickname} | ${ms}ms | ${err.message.slice(0, 200)}`);
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
  // Exclui contas de outros marketplaces (Amazon/Shopee) — qualquer
  // quantidade delas, não só a store sentinela original — que não têm
  // token OAuth do ML e não devem ganhar fila/worker de webhook ML.
  const { rows } = await pool.query(`SELECT id FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);

  // Always include a worker for the 'default' queue (storeId unknown)
  const storeIds = ['default', ...rows.map(r => String(r.id))];

  for (const storeId of storeIds) {
    const w = new Worker(`ml-webhooks-${storeId}`, processJob, {
      connection: new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false }),
      // Cada loja tem app ML próprio = rate limit independente.
      // concurrency:3 + limiter 3/3s = máx 60 req/min por loja (ML permite 3000/min por app).
      concurrency: 3,
      limiter: { max: 3, duration: 3000 },
    });
    attachWorkerEvents(w, storeId);
    console.log(`[worker] started queue ml-webhooks-${storeId}`);
  }

  // Legacy worker — processa jobs ainda na fila global antiga (sem store separado)
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

// ── Helpers compartilhados pelos syncs ───────────────────────

async function ensureTokenFresh(store) {
  const tokenExpAt = store.token_expires_at ? new Date(store.token_expires_at) : null;
  const expiresIn  = tokenExpAt ? (tokenExpAt - Date.now()) : -1;
  if (expiresIn < 30 * 60 * 1000) {
    try {
      await refreshToken(store.id);
      expiredStores.delete(store.id);
      console.log(`[sync] 🔑 token renovado: ${store.nickname}`);
    } catch (e) {
      console.warn(`[sync] 🔑 refresh falhou ${store.nickname}: ${e.message}`);
    }
  }
}

// ── Registro de execuções de sync no banco ─────────────────
async function recordSync(name, cron, fn) {
  const startedAt = new Date();
  let runId;
  try {
    await pool.query(
      `INSERT INTO schedule_jobs (name, cron, last_run, status)
       VALUES ($1,$2,now(),'running')
       ON CONFLICT (name) DO UPDATE SET last_run=now(), status='running', cron=$2`,
      [name, cron]
    );
    const { rows } = await pool.query(
      `INSERT INTO schedule_runs (job_name, started_at, status) VALUES ($1,$2,'running') RETURNING id`,
      [name, startedAt]
    );
    runId = rows[0]?.id;
  } catch(e) { console.warn('[recordSync] erro ao registrar início:', e.message); }

  let report = null, status = 'success', errorMsg = null;
  try {
    report = await fn();
  } catch(e) {
    status = 'error';
    errorMsg = e.message;
    throw e;
  } finally {
    const durationMs = Date.now() - startedAt.getTime();
    try {
      await pool.query(
        `UPDATE schedule_jobs SET duration_ms=$1, status=$2 WHERE name=$3`,
        [durationMs, status, name]
      );
      if (runId) {
        await pool.query(
          `UPDATE schedule_runs SET finished_at=now(), duration_ms=$1, status=$2, report=$3, error_msg=$4 WHERE id=$5`,
          [durationMs, status, JSON.stringify(report), errorMsg, runId]
        );
      }
    } catch(e) { console.warn('[recordSync] erro ao registrar fim:', e.message); }
  }
  return report;
}

function scheduleAt(hour, minute, fn, label) {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`[${label}] próxima execução: ${next.toLocaleString('pt-BR')} (em ${Math.round(ms / 60000)}min)`);
  setTimeout(fn, ms);
}

// Igual a scheduleAt, mas para jobs que rodam várias vezes ao dia num
// intervalo fixo (ex: a cada 4h — 00h/04h/08h/12h/16h/20h) em vez de uma
// vez por dia num horário fixo. Mesma mecânica de auto-reagendamento via
// setTimeout recursivo.
function scheduleEvery(hours, fn, label) {
  const now = new Date();
  let next = new Date(now);
  next.setHours(0, 0, 0, 0);
  while (next <= now) next = new Date(next.getTime() + hours * 3600000);
  const ms = next - now;
  console.log(`[${label}] próxima execução: ${next.toLocaleString('pt-BR')} (em ${Math.round(ms / 60000)}min)`);
  setTimeout(fn, ms);
}

// Igual a scheduleEvery, mas alinhado por MINUTOS em vez de horas (ex.: a
// cada 10min → roda em :00/:10/:20/:30/:40/:50, não "10min depois de quando
// o processo subiu"). Único caso hoje que precisa de granularidade menor
// que 1h — os demais jobs usam scheduleAt/scheduleEvery.
function scheduleEveryMinutes(minutes, fn, label) {
  const now = new Date();
  let next = new Date(now);
  next.setHours(0, 0, 0, 0);
  while (next <= now) next = new Date(next.getTime() + minutes * 60000);
  const ms = next - now;
  console.log(`[${label}] próxima execução: ${next.toLocaleString('pt-BR')} (em ${Math.round(ms / 60000)}min)`);
  setTimeout(fn, ms);
}

// Igual a scheduleAt, mas para jobs semanais (ex: toda 2ª-feira). dayOfWeek:
// 0=domingo, 1=segunda, ... 6=sábado (mesma convenção de Date.getDay()).
function scheduleWeekly(dayOfWeek, hour, minute, fn, label) {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  next.setDate(next.getDate() + ((dayOfWeek - next.getDay() + 7) % 7));
  if (next <= now) next.setDate(next.getDate() + 7);
  const ms = next - now;
  console.log(`[${label}] próxima execução: ${next.toLocaleString('pt-BR')} (em ${Math.round(ms / 60000)}min)`);
  setTimeout(fn, ms);
}

// ── Sync Vendas — 03:00 diário, pedidos dos últimos 3 dias ───
let isSyncingVendas = false;

async function syncVendas() {
  if (isSyncingVendas) { console.warn('[sync-vendas] já em execução — ignorando'); return; }
  isSyncingVendas = true;
  console.log('[sync-vendas] iniciando reconciliação de pedidos...');

  try {
    return await recordSync('sync-vendas', '0 3 * * *', async () => {
      // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
      const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      const dateFrom = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const lojaReport = [];

      let totalNew = 0;

      for (const store of stores) {
        await ensureTokenFresh(store);
        let offset = 0, apiTotal = Infinity, storeNew = 0, consecutive429 = 0;

        storeLoop:
        while (offset < apiTotal) {
          let data;
          try {
            data = await ml.searchOrders(store.id, dateFrom, offset);
            consecutive429 = 0;
          } catch (e) {
            if (e.message?.includes('429')) {
              consecutive429++;
              const waitMs = consecutive429 === 1 ? 60000 : 120000; // 1min na 1ª, 2min da 2ª em diante
              console.warn(`[sync-vendas] ${store.nickname} 429 (${consecutive429}/5) — aguardando ${waitMs/1000}s`);
              if (consecutive429 >= 5) {
                console.warn(`[sync-vendas] ${store.nickname} 5 consecutive 429s — abortando loja`);
                lojaReport.push({ loja: store.nickname, pedidos_importados: storeNew, erro: 'rate_limit_abort' });
                break storeLoop;
              }
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
            console.error(`[sync-vendas] ${store.nickname} erro:`, e.message);
            lojaReport.push({ loja: store.nickname, pedidos_importados: storeNew, erro: e.message });
            break storeLoop;
          }

          const orders = data.results || [];
          apiTotal = data.paging?.total ?? orders.length;
          console.log(`[sync-vendas] ${store.nickname} offset=${offset}/${apiTotal} → ${orders.length} pedidos`);
          if (!orders.length) break;

          for (const order of orders) {
            const exists = await pool.query(
              `SELECT ml_id FROM orders WHERE ml_id=$1 AND updated_at > now() - interval '12 hours'`, [order.id]
            );
            if (exists.rows.length) continue;
            try {
              await handleOrder({ resource: `/orders/${order.id}`, storeId: store.id, silent: true });
              storeNew++;
              consecutive429 = 0;
            } catch (e) {
              if (e.message?.includes('429')) {
                consecutive429++;
                const waitMs = consecutive429 === 1 ? 60000 : 120000; // 1min na 1ª, 2min da 2ª em diante
                console.warn(`[sync-vendas] ${store.nickname} 429 no handleOrder (${consecutive429}/5) — aguardando ${waitMs/1000}s`);
                if (consecutive429 >= 5) {
                  console.warn(`[sync-vendas] ${store.nickname} 5 consecutive 429s — abortando loja`);
                  lojaReport.push({ loja: store.nickname, pedidos_importados: storeNew, erro: 'rate_limit_abort' });
                  break storeLoop;
                }
                await new Promise(r => setTimeout(r, waitMs));
              } else {
                console.error(`[sync-vendas] ${store.nickname} order ${order.id} erro:`, e.message);
              }
            }
            await new Promise(r => setTimeout(r, 20000)); // 20s entre pedidos — mesmo ritmo do sync-visitas (ver decisions.md)
          }

          offset += orders.length;
          if (orders.length < 50) break;
          await new Promise(r => setTimeout(r, 2000));
        }

        console.log(`[sync-vendas] ${store.nickname} → ${storeNew} importados`);
        if (!lojaReport.find(r => r.loja === store.nickname)) {
          lojaReport.push({ loja: store.nickname, pedidos_importados: storeNew });
        }
        totalNew += storeNew;
      }

      console.log(`[sync-vendas] concluído — ${totalNew} pedidos importados`);
      if (totalNew > 0) {
        await tgNotify('tg_infra', `✅ <b>Sync Vendas</b>\n📦 ${totalNew} pedidos recuperados/atualizados`).catch(() => {});
      }

      // syncParentItems roda somente às 01:30 para não competir com webhooks de pedidos

      return { total_pedidos_importados: totalNew, lojas: lojaReport };
    });
  } finally {
    isSyncingVendas = false;
    scheduleAt(3, 0, syncVendas, 'sync-vendas');
  }
}

// Alias para compatibilidade com comandos Redis e Telegram existentes
async function dailySync() { return syncVendas(); }

// ── Sync Métricas — 04:15 diário, reputação + devoluções ─────
let isSyncingMetricas = false;

async function syncMetricas() {
  if (isSyncingMetricas) { console.warn('[sync-metricas] já em execução — ignorando'); return; }
  isSyncingMetricas = true;
  console.log('[sync-metricas] iniciando coleta de métricas...');

  try {
    return await recordSync('sync-metricas', '15 4 * * *', async () => {
      // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
      const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      const lojaReport = [];

      async function syncStoreMetricas(store) {
        await ensureTokenFresh(store);
        let nivel = null, claimsNew = 0;

        try {
          const rep = await ml.getSellerReputation(store.id);
          if (rep) {
            nivel = rep.level_id;
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
            console.log(`[sync-metricas] ${store.nickname} reputação: ${rep.level_id}`);
          }
        } catch (e) { console.warn(`[sync-metricas] reputação ${store.nickname}: ${e.message}`); }

        try {
          const data = await ml.searchClaims(store.id, 0);
          const claims = data?.data || [];
          for (const c of claims) {
            try {
              await new Promise(r => setTimeout(r, 1500));
              const claim = await ml.getClaim(c.id, store.id);
              const orderId = claimOrderId(claim);
              const buyerNickname = claim.players?.find(p => p.role === 'complainant')?.user_id?.toString() || null;
              await resolveClaimReason(claim.reason_id, store.id);
              const amount = await resolveReturnAmount(orderId);
              const up = await upsertClaim({ storeId: store.id, orderId, buyerNickname, amount, claim });
              if (up.isNew) claimsNew++;
            } catch (e) { console.warn(`[sync-metricas] claim=${c.id}: ${e.message}`); }
          }
        } catch (e) { console.warn(`[sync-metricas] devoluções ${store.nickname}: ${e.message}`); }

        console.log(`[sync-metricas] ${store.nickname} → reputação OK, ${claimsNew} devoluções novas`);
        return { loja: store.nickname, nivel_reputacao: nivel, devolucoes_novas: claimsNew };
      }

      const results = await Promise.allSettled(stores.map(s => syncStoreMetricas(s)));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') lojaReport.push(r.value);
        else { lojaReport.push({ loja: stores[i].nickname, erro: r.reason?.message }); console.error(`[sync-metricas] ${stores[i].nickname} erro:`, r.reason?.message); }
      });

      console.log('[sync-metricas] concluído');
      await tgNotify('tg_infra', `📊 <b>Sync Métricas</b> concluído\n🏪 ${stores.length} lojas atualizadas`).catch(() => {});
      return { lojas: lojaReport };
    });
  } finally {
    isSyncingMetricas = false;
    scheduleAt(4, 15, syncMetricas, 'sync-metricas');
  }
}

// ── Sync SEO Score (Qualidade de Anúncio) — 04:30 diário ──────────────────────
// Fórmula determinística (server/src/seoScore.js) — nunca IA. 2 chamadas novas
// por item (getItem já existia, description e atributos de categoria são
// novas — a última cacheada, ver category_attributes_cache). Mesmo padrão de
// throttling/circuit-breaker de syncScores. Ver .claude/decisions.md.
let isSyncingSeoScore = false;
const CATEGORY_ATTRS_CACHE_DAYS = 30;

async function getRequiredAttrsForCategory(categoryId, storeId, localCache) {
  if (!categoryId) return [];
  if (localCache.has(categoryId)) return localCache.get(categoryId);

  const { rows } = await pool.query(
    `SELECT required_ids, updated_at FROM category_attributes_cache WHERE category_id=$1`,
    [categoryId]
  );
  const cached = rows[0];
  const isFresh = cached && (Date.now() - new Date(cached.updated_at).getTime()) < CATEGORY_ATTRS_CACHE_DAYS * 86400000;
  if (isFresh) {
    localCache.set(categoryId, cached.required_ids || []);
    return cached.required_ids || [];
  }

  try {
    const attrs = await ml.getCategoryAttributes(categoryId, storeId);
    const requiredIds = (Array.isArray(attrs) ? attrs : []).filter(a => a.tags?.required).map(a => a.id);
    await pool.query(
      `INSERT INTO category_attributes_cache (category_id, required_ids, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (category_id) DO UPDATE SET required_ids=EXCLUDED.required_ids, updated_at=now()`,
      [categoryId, requiredIds]
    );
    localCache.set(categoryId, requiredIds);
    return requiredIds;
  } catch (e) {
    console.warn(`[sync-seo-score] atributos categoria ${categoryId}: ${e.message}`);
    const fallback = cached?.required_ids || [];
    localCache.set(categoryId, fallback);
    return fallback;
  }
}

// Nome REAL da categoria (Analista Ecom, v92) — mesmo padrão de cache acima
// (category_attributes_cache), mas SEM expiração: nome de categoria do ML
// não muda na prática, então só busca de novo se ainda não tiver linha
// cacheada (nunca refaz a chamada só pra confirmar o mesmo valor). Nunca
// chamada de rota HTTP de leitura — só daqui (worker), ver decisions.md.
async function getCategoryName(categoryId, storeId, localCache) {
  if (!categoryId) return null;
  if (localCache.has(categoryId)) return localCache.get(categoryId);

  const { rows } = await pool.query(`SELECT name FROM category_names_cache WHERE category_id=$1`, [categoryId]);
  if (rows[0]) { localCache.set(categoryId, rows[0].name); return rows[0].name; }

  try {
    const cat = await ml.getCategory(categoryId, storeId);
    const name = cat?.name || null;
    if (name) {
      await pool.query(
        `INSERT INTO category_names_cache (category_id, name, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (category_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,
        [categoryId, name]
      );
    }
    localCache.set(categoryId, name);
    return name;
  } catch (e) {
    console.warn(`[sync-seo-score] nome categoria ${categoryId}: ${e.message}`);
    localCache.set(categoryId, null);
    return null;
  }
}

async function syncSeoScore() {
  if (isSyncingSeoScore) { console.warn('[sync-seo-score] já em execução — ignorando'); return; }
  isSyncingSeoScore = true;
  console.log('[sync-seo-score] iniciando sync de Qualidade de Anúncio...');
  try {
    return await recordSync('sync-seo-score', '30 4 * * *', async () => {
      const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      let totalSynced = 0, totalErrors = 0;
      const lojaReport = [];
      const categoryAttrsCache = new Map();
      const categoryNamesCache = new Map();

      for (const store of stores) {
        try {
          await ensureTokenFresh(store);
          const { rows: items } = await pool.query(
            `SELECT ml_id, title, category_id FROM items WHERE store_id=$1 AND status='active' ORDER BY ml_id LIMIT 100`,
            [store.id]
          );
          console.log(`[sync-seo-score] ${store.nickname}: ${items.length} itens ativos`);

          // Visitas e vendas dos últimos 30 dias — 1 query por loja, não por item (sem N+1).
          const { rows: visitRows } = await pool.query(
            `SELECT item_id, SUM(visits)::int AS visits_30d FROM item_visits WHERE store_id=$1 AND date >= CURRENT_DATE - 30 GROUP BY item_id`,
            [store.id]
          );
          const visitsMap = new Map(visitRows.map(r => [r.item_id, r.visits_30d]));
          const { rows: salesRows } = await pool.query(
            `SELECT item_id, COUNT(*)::int AS sales_30d FROM orders WHERE store_id=$1 AND date_created >= CURRENT_DATE - 30 AND status != 'cancelled' GROUP BY item_id`,
            [store.id]
          );
          const salesMap = new Map(salesRows.map(r => [r.item_id, r.sales_30d]));

          let synced = 0, errors = 0;
          let consecutiveRateLimit = 0;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
              const full = await ml.getItem(item.ml_id, store.id);
              consecutiveRateLimit = 0;

              let descWords = 0;
              try {
                const desc = await ml.getItemDescription(item.ml_id, store.id);
                const text = desc?.plain_text || desc?.text || '';
                descWords = text.trim() ? text.trim().split(/\s+/).length : 0;
              } catch (e) {
                if (e.message?.includes('429') || e.message?.includes('rate limit')) throw e;
                // item sem descrição própria (ex: variação) — ok, conta 0
              }

              const categoryId = full.category_id || item.category_id;
              const requiredIds = await getRequiredAttrsForCategory(categoryId, store.id, categoryAttrsCache);
              await getCategoryName(categoryId, store.id, categoryNamesCache); // só cacheia (Analista Ecom) — sem TTL, pula se já tem linha
              const presentIds = new Set((full.attributes || []).filter(a => a.value_name != null && a.value_name !== '').map(a => a.id));
              const missingRequired = requiredIds.filter(id => !presentIds.has(id));

              const findAttr = (id) => (full.attributes || []).find(a => a.id === id);
              const gtinAttr = findAttr('GTIN');
              const brandAttr = findAttr('BRAND');
              const modelAttr = findAttr('MODEL');

              const visits30d = visitsMap.get(item.ml_id) || 0;
              const sales30d = salesMap.get(item.ml_id) || 0;
              const conversionRate = visits30d > 0 ? sales30d / visits30d : 0;

              const shippingType = full.shipping?.logistic_type || null;
              const signals = {
                picturesCount: full.pictures?.length || 0,
                hasVideo: !!full.video_id,
                titleLength: (full.title || '').length,
                descriptionWordCount: descWords,
                hasGtin: !!(gtinAttr && gtinAttr.value_name),
                hasBrand: !!(brandAttr && brandAttr.value_name),
                hasModel: !!(modelAttr && modelAttr.value_name),
                isFull: shippingType === 'fulfillment',
                catalogListing: !!full.catalog_listing,
                requiredAttrsTotal: requiredIds.length,
                requiredAttrsMissing: missingRequired.length,
                conversionRate,
                visits30d,
              };
              const { subscores, total } = computeSeoScore(signals);

              await pool.query(
                `INSERT INTO item_seo_score (
                   store_id, item_id, category_id, brand,
                   pictures_count, has_video, title_length, description_word_count,
                   has_gtin, has_brand, has_model, is_full, shipping_type, catalog_listing,
                   required_attrs_total, required_attrs_missing, missing_required_attrs,
                   visits_30d, sales_30d, conversion_rate,
                   photos_score, video_score, title_score, description_score,
                   gtin_score, brand_score, model_score, full_score, catalog_score,
                   attributes_score, conversion_score, visits_score, score, calculated_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,now())
                 ON CONFLICT (item_id) DO UPDATE SET
                   store_id=EXCLUDED.store_id, category_id=EXCLUDED.category_id, brand=EXCLUDED.brand,
                   pictures_count=EXCLUDED.pictures_count, has_video=EXCLUDED.has_video,
                   title_length=EXCLUDED.title_length, description_word_count=EXCLUDED.description_word_count,
                   has_gtin=EXCLUDED.has_gtin, has_brand=EXCLUDED.has_brand, has_model=EXCLUDED.has_model,
                   is_full=EXCLUDED.is_full, shipping_type=EXCLUDED.shipping_type, catalog_listing=EXCLUDED.catalog_listing,
                   required_attrs_total=EXCLUDED.required_attrs_total, required_attrs_missing=EXCLUDED.required_attrs_missing,
                   missing_required_attrs=EXCLUDED.missing_required_attrs,
                   visits_30d=EXCLUDED.visits_30d, sales_30d=EXCLUDED.sales_30d, conversion_rate=EXCLUDED.conversion_rate,
                   photos_score=EXCLUDED.photos_score, video_score=EXCLUDED.video_score,
                   title_score=EXCLUDED.title_score, description_score=EXCLUDED.description_score,
                   gtin_score=EXCLUDED.gtin_score, brand_score=EXCLUDED.brand_score, model_score=EXCLUDED.model_score,
                   full_score=EXCLUDED.full_score, catalog_score=EXCLUDED.catalog_score,
                   attributes_score=EXCLUDED.attributes_score, conversion_score=EXCLUDED.conversion_score,
                   visits_score=EXCLUDED.visits_score, score=EXCLUDED.score, calculated_at=now()`,
                [
                  store.id, item.ml_id, categoryId, brandAttr?.value_name || null,
                  signals.picturesCount, signals.hasVideo, signals.titleLength, signals.descriptionWordCount,
                  signals.hasGtin, signals.hasBrand, signals.hasModel, signals.isFull, shippingType, signals.catalogListing,
                  signals.requiredAttrsTotal, signals.requiredAttrsMissing, missingRequired,
                  visits30d, sales30d, conversionRate,
                  subscores.photos, subscores.video, subscores.title, subscores.description,
                  subscores.gtin, subscores.brand, subscores.model, subscores.full, subscores.catalog,
                  subscores.attributes, subscores.conversion, subscores.visits, total,
                ]
              );
              await pool.query(
                `INSERT INTO item_seo_score_history (item_id, store_id, score) VALUES ($1,$2,$3)`,
                [item.ml_id, store.id, total]
              );
              synced++;
            } catch (e) {
              if (e.message?.includes('429') || e.message?.includes('rate limit')) {
                consecutiveRateLimit++;
                console.warn(`[sync-seo-score] 429 em ${item.ml_id} — aguardando 60s`);
                await new Promise(r => setTimeout(r, 60000));
                if (consecutiveRateLimit >= 5) {
                  console.error(`[sync-seo-score] ${store.nickname}: 5 rate limits seguidos — abortando loja`);
                  throw new Error('Rate limit persistente — abortado após 5 tentativas consecutivas');
                }
              } else {
                console.warn(`[sync-seo-score] erro em ${item.ml_id}: ${e.message}`);
                errors++;
              }
            }
            // 10s entre itens
            await new Promise(r => setTimeout(r, 10000));
            // A cada 10 itens, pausa extra de 30s
            if ((i + 1) % 10 === 0) {
              console.log(`[sync-seo-score] ${store.nickname}: lote ${Math.ceil((i+1)/10)} concluído (${i+1}/${items.length}) — pausa 30s`);
              await new Promise(r => setTimeout(r, 30000));
            }
          }

          totalSynced += synced;
          totalErrors += errors;
          lojaReport.push({ loja: store.nickname, synced, errors });
          console.log(`[sync-seo-score] ${store.nickname}: ${synced} ok, ${errors} erros`);
          await new Promise(r => setTimeout(r, 3000)); // 3s entre lojas
        } catch (e) {
          console.error(`[sync-seo-score] erro na loja ${store.nickname}:`, e.message);
          lojaReport.push({ loja: store.nickname, erro: e.message });
        }
      }

      console.log(`[sync-seo-score] concluído: ${totalSynced} atualizados, ${totalErrors} erros`);
      return { synced: totalSynced, errors: totalErrors, lojas: lojaReport };
    });
  } finally {
    isSyncingSeoScore = false;
    scheduleAt(4, 30, syncSeoScore, 'sync-seo-score');
  }
}

// ── Sync Monitor de Buy-Box (catálogo) — 04:50 diário ─────────────────────────
// 1 chamada por item catalog_listing=true (já conhecido via item_seo_score, v25)
// **OU** alocado no estágio "Catálogo (Buy Box)" do Rankeamento (v88,
// ranking_ads.fase='catalogo' — pedido explícito do usuário: aloca TODOS os
// anúncios de catálogo lá, e o job cobre "aos poucos" nas próximas execuções,
// sem precisar chamar a API na hora de todos de uma vez) — union deduplicado
// por item_id. price_to_win traz tudo num payload só (preço, vencedor, boosts
// faltando, catalog_product_id), sem precisar de getItem extra. Lista de
// concorrentes (products/:id/items) NÃO é buscada aqui — é sob demanda (rota
// da API, ver .claude/decisions.md), pra não gastar 2 chamadas/item/dia à
// toa. Itens NUNCA sincronizados (calculated_at NULL) entram primeiro —
// prioriza quem acabou de ser alocado sobre quem já tem dado, mesmo que o
// catálogo inteiro não caiba numa execução só.
let isSyncingCatalogCompetition = false;

async function syncCatalogCompetition() {
  if (isSyncingCatalogCompetition) { console.warn('[sync-catalog-competition] já em execução — ignorando'); return; }
  isSyncingCatalogCompetition = true;
  console.log('[sync-catalog-competition] iniciando sync de Buy-Box...');
  try {
    return await recordSync('sync-catalog-competition', '50 4 * * *', async () => {
      const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      let totalSynced = 0, totalErrors = 0;
      const lojaReport = [];

      for (const store of stores) {
        try {
          await ensureTokenFresh(store);
          const { rows: items } = await pool.query(
            `SELECT item_id, MIN(calculated_at) AS calculated_at FROM (
               SELECT sq.item_id, cc.calculated_at FROM item_seo_score sq
                 LEFT JOIN catalog_competition cc ON cc.item_id = sq.item_id
                WHERE sq.store_id=$1 AND sq.catalog_listing=true
               UNION
               SELECT r.ml_id AS item_id, cc.calculated_at FROM ranking_ads r
                 LEFT JOIN catalog_competition cc ON cc.item_id = r.ml_id
                WHERE r.store_id=$1 AND r.fase='catalogo' AND r.active=true
             ) x GROUP BY item_id
             ORDER BY calculated_at ASC NULLS FIRST, item_id`,
            [store.id]
          );
          console.log(`[sync-catalog-competition] ${store.nickname}: ${items.length} itens de catálogo`);

          let synced = 0, errors = 0;
          let consecutiveRateLimit = 0;

          for (let i = 0; i < items.length; i++) {
            const itemId = items[i].item_id;
            try {
              await fetchAndSaveCatalogCompetition(ml, itemId, store.id);
              consecutiveRateLimit = 0;
              synced++;
            } catch (e) {
              if (e.message?.includes('429') || e.message?.includes('rate limit')) {
                consecutiveRateLimit++;
                console.warn(`[sync-catalog-competition] 429 em ${itemId} — aguardando 60s`);
                await new Promise(r => setTimeout(r, 60000));
                if (consecutiveRateLimit >= 5) {
                  console.error(`[sync-catalog-competition] ${store.nickname}: 5 rate limits seguidos — abortando loja`);
                  throw new Error('Rate limit persistente — abortado após 5 tentativas consecutivas');
                }
              } else {
                console.warn(`[sync-catalog-competition] erro em ${itemId}: ${e.message}`);
                errors++;
              }
            }
            await new Promise(r => setTimeout(r, 10000));
            if ((i + 1) % 10 === 0) {
              console.log(`[sync-catalog-competition] ${store.nickname}: lote ${Math.ceil((i+1)/10)} concluído (${i+1}/${items.length}) — pausa 30s`);
              await new Promise(r => setTimeout(r, 30000));
            }
          }

          totalSynced += synced;
          totalErrors += errors;
          lojaReport.push({ loja: store.nickname, synced, errors });
          console.log(`[sync-catalog-competition] ${store.nickname}: ${synced} ok, ${errors} erros`);
          await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          console.error(`[sync-catalog-competition] erro na loja ${store.nickname}:`, e.message);
          lojaReport.push({ loja: store.nickname, erro: e.message });
        }
      }

      console.log(`[sync-catalog-competition] concluído: ${totalSynced} atualizados, ${totalErrors} erros`);
      return { synced: totalSynced, errors: totalErrors, lojas: lojaReport };
    });
  } finally {
    isSyncingCatalogCompetition = false;
    scheduleAt(4, 50, syncCatalogCompetition, 'sync-catalog-competition');
  }
}

// ── Sync Preços Promocionais — 05:00 diário ───────────────────────────────────
let isSyncingPrecos = false;

async function syncPrecos() {
  if (isSyncingPrecos) { console.warn('[sync-precos] já em execução — ignorando'); return; }
  isSyncingPrecos = true;
  console.log('[sync-precos] iniciando sync de preços promocionais...');
  try {
    return await recordSync('sync-precos', '0 5 * * *', async () => {
      const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE access_token IS NOT NULL`);
      let updated = 0, skipped = 0, errors = 0;
      for (const s of stores) {
        const { rows: items } = await pool.query(
          `SELECT ml_id FROM items WHERE store_id=$1 AND status != 'closed'`, [s.id]
        );
        for (const it of items) {
          try {
            const data = await ml.getItem(it.ml_id, s.id);
            // Medidas da caixa: aproveita o mesmo getItem (custo zero) pra manter
            // items.package_dims atualizado — a Embalagem lê do banco no bipe.
            const dims = packageDimsFromItem(data);
            if (data.original_price && Number(data.original_price) > 0) {
              await pool.query(
                `UPDATE items SET original_price=$1, package_dims=COALESCE($2::jsonb, package_dims) WHERE ml_id=$3`,
                [data.original_price, dims ? JSON.stringify(dims) : null, it.ml_id]
              );
              updated++;
            } else {
              // sem promoção — limpa original_price para não exibir desconto falso
              await pool.query(
                `UPDATE items SET original_price=0, package_dims=COALESCE($1::jsonb, package_dims) WHERE ml_id=$2`,
                [dims ? JSON.stringify(dims) : null, it.ml_id]
              );
              skipped++;
            }
          } catch (e) {
            console.warn(`[sync-precos] skip ${it.ml_id}:`, e.message);
            errors++;
          }
        }
        console.log(`[sync-precos] ${s.nickname}: ${items.length} itens processados`);
      }
      await publish('anuncio_updated', { sync: 'precos' });
      return { updated, skipped, errors };
    });
  } finally {
    isSyncingPrecos = false;
    scheduleAt(5, 0, syncPrecos, 'sync-precos');
  }
}

// ── Conciliação Bancária: reconsulta pagamentos ainda não liberados ────────
// O webhook `payments` só dispara em eventos de pagamento (aprovação, etc.) —
// a liberação (`money_release_date`) acontece semanas depois (~28 dias
// observado ao vivo) dentro do Mercado Pago, sem gerar necessariamente um
// novo webhook do Mercado Livre. Sem isso, `ml_payments.released` ficaria
// travado em 'no' pra sempre mesmo depois do dinheiro ser liberado de
// verdade. Roda 1x/dia (cadência baixa é suficiente — não é evento de
// minutos) e reconsulta só os pagamentos ainda não liberados, priorizando
// os com `money_release_date` mais próxima. Ver .claude/decisions.md.
let isSyncingPaymentReleases = false;

async function syncPaymentReleases() {
  if (isSyncingPaymentReleases) { console.warn('[sync-payment-releases] já em execução — ignorando'); return; }
  isSyncingPaymentReleases = true;
  console.log('[sync-payment-releases] iniciando reconsulta de pagamentos não liberados...');
  try {
    return await recordSync('sync-payment-releases', '15 5 * * *', async () => {
      const { rows: pending } = await pool.query(
        `SELECT payment_id, store_id FROM ml_payments
         WHERE released IS DISTINCT FROM 'yes'
         ORDER BY money_release_date ASC NULLS LAST
         LIMIT 200`
      );
      let updated = 0, errors = 0;
      // Circuit breaker POR LOJA (mesmo padrão de syncShippingStatus, ver
      // decisions.md/known-bugs #10): um 429 de uma loja não pode abortar o lote
      // inteiro — só pausa a loja rate-limited (3x 429 seguidos), as outras seguem.
      const blockedStores = new Set();
      const store429 = new Map();
      for (const p of pending) {
        if (blockedStores.has(p.store_id)) continue;
        try {
          const payment = await ml.getPayment(p.payment_id, p.store_id);
          const c = payment?.collection || payment;
          await pool.query(
            `UPDATE ml_payments SET
               status=$2, status_detail=$3, net_received_amount=$4, money_release_date=$5,
               released=$6, marketplace_fee=$7, mercadopago_fee=$8, discount_fee=$9,
               coupon_fee=$10, finance_fee=$11, amount_refunded=$12, raw_data=$13, updated_at=now()
             WHERE payment_id=$1`,
            [
              p.payment_id, c?.status || null, c?.status_detail || null,
              c?.net_received_amount ?? null, c?.money_release_date || null, c?.released ?? null,
              c?.marketplace_fee ?? null, c?.mercadopago_fee ?? null, c?.discount_fee ?? null,
              c?.coupon_fee ?? null, c?.finance_fee ?? null, c?.amount_refunded ?? null,
              JSON.stringify(payment),
            ]
          );
          updated++;
          store429.set(p.store_id, 0); // sucesso reseta o contador da loja
        } catch (e) {
          errors++;
          if (e.message?.includes('429')) {
            const n = (store429.get(p.store_id) || 0) + 1;
            store429.set(p.store_id, n);
            console.warn(`[sync-payment-releases] 429 loja ${p.store_id} (${n}/3): ${e.message}`);
            if (n >= 3) { blockedStores.add(p.store_id); console.warn(`[sync-payment-releases] loja ${p.store_id} pausada nesta execução (3x 429) — demais lojas seguem`); }
          } else {
            console.warn(`[sync-payment-releases] erro payment=${p.payment_id}: ${e.message}`);
          }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[sync-payment-releases] concluído: ${updated} atualizados, ${errors} erros (de ${pending.length} pendentes)`);
      return { updated, errors, total: pending.length };
    });
  } finally {
    isSyncingPaymentReleases = false;
    scheduleAt(5, 15, syncPaymentReleases, 'sync-payment-releases');
  }
}

// ── Reconciliação automática de frete/tarifa — a cada 10 min ───────────────
// Só pedidos com `finance_synced = false` (nunca "todos" — ver
// financeService.js/migrate-v82.sql pro porquê `ml_fee`/`shipping_seller_cost`
// não servem pra saber se um pedido está pendente: nascem com DEFAULT 0,
// nunca NULL). Usa o MESMO serviço do botão manual "Atualizar"
// (`POST /vendas/:orderId/atualizar`, routes/api.js) — nunca duas lógicas de
// reconciliação (pedido explícito do usuário). Backoff exponencial por
// tentativa (2^tentativas minutos, teto 24h) evita bater sem parar num
// pedido que nunca vai reconciliar (ex.: pagamento que nunca chegou a ser
// criado). Prioriza pedidos das últimas 24h, mas também processa backlog
// antigo — mesma ordem pedida pelo usuário. Circuit breaker por loja, mesmo
// padrão de `syncShippingStatus`/`syncPaymentReleases` acima.
let isSyncingFinance = false;

async function financeReconciliationJob() {
  if (isSyncingFinance) { console.warn('[FINANCE-JOB] já em execução — ignorando'); return; }
  isSyncingFinance = true;
  console.log('[FINANCE-JOB] Iniciando reconciliação financeira');
  try {
    return await recordSync('finance-reconciliation', '*/10 * * * *', async () => {
      const { rows: pending } = await pool.query(
        `SELECT ml_id, store_id, finance_sync_attempts
         FROM orders
         WHERE finance_synced = false
           AND status <> 'cancelled'
           AND (
             last_finance_sync_at IS NULL
             OR last_finance_sync_at < now() - (LEAST(POWER(2, finance_sync_attempts)::int, 1440) || ' minutes')::interval
           )
         ORDER BY
           CASE WHEN date_created >= now() - interval '24 hours' THEN 0 ELSE 1 END,
           date_created ASC
         LIMIT 50`
      );
      console.log(`[FINANCE-JOB] Vendas pendentes encontradas: ${pending.length}`);

      let atualizadas = 0, semDados = 0, erros = 0;
      const blockedStores = new Set();
      const store429 = new Map();
      for (const o of pending) {
        if (blockedStores.has(o.store_id)) continue;
        console.log(`[FINANCE-JOB] Processando order_id: ${o.ml_id}`);
        let waitMs = 1200;
        try {
          const r = await financeService.reconciliarPedido(o.ml_id);
          if (!r.ok) {
            erros++;
            console.warn(`[FINANCE-JOB] erro order_id=${o.ml_id}: ${r.error}`);
            if (r.error?.includes('429')) {
              waitMs = 20000;
              const n = (store429.get(o.store_id) || 0) + 1;
              store429.set(o.store_id, n);
              if (n >= 3) { blockedStores.add(o.store_id); console.warn(`[FINANCE-JOB] loja ${o.store_id} pausada nesta execução (3x 429) — demais lojas seguem`); }
            }
          } else if (r.finance_synced) {
            atualizadas++;
            console.log(`[FINANCE-JOB] Frete vendedor: R$ ${Number(r.row.freteVend).toFixed(2)} · Tarifa: R$ ${Number(r.row.tarifa).toFixed(2)} · Margem recalculada: ${Number(r.row.mc_pct).toFixed(1)}%`);
            store429.set(o.store_id, 0);
          } else {
            // Confirmou parcialmente (ex.: pedido sem pagamento registrado
            // ainda) — não é erro, fica pendente pra próxima janela.
            semDados++;
            store429.set(o.store_id, 0);
          }
        } catch (e) {
          erros++;
          console.warn(`[FINANCE-JOB] exceção order_id=${o.ml_id}: ${e.message}`);
        }
        await new Promise(r2 => setTimeout(r2, waitMs));
      }
      console.log(`[FINANCE-JOB] Finalizado\nProcessadas: ${pending.length}\nAtualizadas: ${atualizadas}\nSem dados: ${semDados}\nErros: ${erros}`);
      return { processadas: pending.length, atualizadas, sem_dados: semDados, erros };
    });
  } finally {
    isSyncingFinance = false;
    scheduleEveryMinutes(10, financeReconciliationJob, 'finance-reconciliation');
  }
}

// Reconsulta status de entrega — o webhook `shipments` só é reprocessado se
// chegar um webhook novo do ML pra aquele shipment, mas o ML não garante um
// webhook a cada transição (mesmo racional de `sync-payment-releases`: sem
// reconciliação periódica, `shipping_status` fica travado no último status
// recebido, mesmo que o pedido já tenha avançado — ver `decisions.md`).
// Roda a cada 4h (mesma cadência de `top-vendas`) — status de entrega muda
// dentro de dias, não semanas, então precisa de mais frequência que a
// liberação de pagamento (que é 1x/dia).
let isSyncingShippingStatus = false;

async function syncShippingStatus() {
  if (isSyncingShippingStatus) { console.warn('[sync-shipping-status] já em execução — ignorando'); return; }
  isSyncingShippingStatus = true;
  console.log('[sync-shipping-status] iniciando reconsulta de status de entrega...');
  try {
    return await recordSync('sync-shipping-status', '0 */4 * * *', async () => {
      const { rows: pending } = await pool.query(
        `SELECT ml_id, store_id, shipping_id FROM orders
         WHERE shipping_id IS NOT NULL
           AND shipping_status IS DISTINCT FROM 'delivered'
           AND shipping_status IS DISTINCT FROM 'cancelled'
           AND date_created > now() - interval '45 days'
         ORDER BY shipping_last_updated ASC NULLS FIRST
         LIMIT 120`
      );
      // Circuit breaker por loja (não global) — os 200 pedidos pendentes
      // costumam vir de lojas diferentes, cada uma com token/rate limit
      // independente (mesmo racional de `workers.md`: "isolar por loja
      // garante que o rate limit de uma não trava o processamento das
      // demais"). Um 429 isolado de 1 loja não pode abortar as outras 199
      // ordens só porque a 1ª da fila calhou de ser dessa loja — corrigido
      // depois de observar em produção que isso travava a fila inteira
      // indefinidamente no mesmo pedido a cada execução (ver decisions.md).
      let updated = 0, errors = 0;
      const blockedStores = new Set();
      const storeErrorStreak = new Map();
      for (const o of pending) {
        if (blockedStores.has(o.store_id)) continue;
        let waitMs = 8000; // intervalo base entre chamadas (conservador — a API do ML já está ocupada com webhooks)
        try {
          const ship = await ml.getShipment(o.shipping_id, o.store_id);
          const sh = ship?.status_history || {};
          await pool.query(
            `UPDATE orders SET
               shipping_status=$2, shipping_substatus=$3, date_ready_to_ship=$4,
               date_shipped=$5, date_delivered=$6, shipping_last_updated=$7, updated_at=now()
             WHERE ml_id=$1`,
            [
              o.ml_id, ship?.status || null, ship?.substatus || null,
              sh.date_ready_to_ship || null, sh.date_shipped || null, sh.date_delivered || null,
              ship?.last_updated || null,
            ]
          );
          updated++;
          storeErrorStreak.set(o.store_id, 0);
        } catch (e) {
          console.warn(`[sync-shipping-status] erro order=${o.ml_id} shipping_id=${o.shipping_id}: ${e.message}`);
          errors++;
          if (e.message?.includes('429')) {
            waitMs = 20000; // tomou 429 → espera bem mais antes da próxima, pra dar tempo do limite resetar
            const streak = (storeErrorStreak.get(o.store_id) || 0) + 1;
            storeErrorStreak.set(o.store_id, streak);
            if (streak >= 3) {
              blockedStores.add(o.store_id);
              console.warn(`[sync-shipping-status] loja ${o.store_id} — 3 erros 429 seguidos, pausando o resto desta loja nesta execução`);
            }
          }
        }
        await new Promise(r => setTimeout(r, waitMs));
      }
      console.log(`[sync-shipping-status] concluído: ${updated} atualizados, ${errors} erros (de ${pending.length} pendentes)`);
      return { updated, errors, total: pending.length };
    });
  } finally {
    isSyncingShippingStatus = false;
    scheduleEvery(4, syncShippingStatus, 'sync-shipping-status');
  }
}

// Snapshot de rankeamento FASE 1 (a cada 6h): anúncios ainda 'rankeando' —
// notifica qualquer mudança (visitas/qualidade/buy-box/Mais Vendidos). Vendas e
// preço/estoque já vêm em tempo real pelos webhooks; este job cobre o resto.
let isSyncingRanking = false;
async function syncRanking() {
  if (isSyncingRanking) return;
  isSyncingRanking = true;
  try {
    return await recordSync('sync-ranking', '0 */6 * * *', async () => {
      const r = await ranking.snapshot('rankeando');
      console.log(`[sync-ranking] snapshot rankeando: ${r.checked}/${r.total} anúncios`);
      // v80 — 'recuperacao' e 'monitoramento' rodam na MESMA janela (mesma
      // cadência de 6h, uma só rajada de chamadas ao ML). As duas são fases de
      // intervenção: precisam de visitas/qualidade frescas pra medir o efeito
      // das alterações. Antes da v80 'monitoramento' não era varrida por job
      // nenhum, então o card ficava com visitas/qualidade vazias pra sempre.
      const rec = await ranking.snapshot('recuperacao');
      console.log(`[sync-ranking] snapshot recuperacao: ${rec.checked}/${rec.total} anúncios`);
      const mon = await ranking.snapshot('monitoramento');
      console.log(`[sync-ranking] snapshot monitoramento: ${mon.checked}/${mon.total} anúncios`);
      return { ...r, recuperacao: rec, monitoramento: mon };
    });
  } finally {
    isSyncingRanking = false;
    scheduleEvery(6, syncRanking, 'sync-ranking');
  }
}

// Snapshot de rankeamento FASE 2 (1x/dia): anúncios 'ranqueado' (consolidados) —
// SÓ regressão (perdeu buy-box, saiu/caiu nos Mais Vendidos, visitas -40%,
// qualidade piorou) + alerta "esfriou". Cadência menor = menos chamadas ao ML.
let isSyncingRankingRanqueado = false;
async function syncRankingRanqueado() {
  if (isSyncingRankingRanqueado) return;
  isSyncingRankingRanqueado = true;
  try {
    return await recordSync('sync-ranking-ranqueado', '15 5 * * *', async () => {
      const r = await ranking.snapshot('ranqueado');
      console.log(`[sync-ranking-ranqueado] snapshot: ${r.checked}/${r.total} anúncios`);
      return r;
    });
  } finally {
    isSyncingRankingRanqueado = false;
  }
}

// Dispara alertas agendados de revisão de ADS de anúncios em rankeamento.
// Verifica a cada hora e envia via Telegram quando a hora chegar.
// Escapa texto para o parse_mode HTML do Telegram (título de anúncio com &, <
// ou > faz a API recusar a mensagem inteira). Existia como `esc(...)` no job de
// alertas, mas nunca foi definido: toda execução caía em "esc is not defined",
// o erro era engolido pelo catch de cada alerta e nada era enviado.
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let isSyncingRankingAlerts = false;
async function syncRankingAlerts() {
  if (isSyncingRankingAlerts) return;
  isSyncingRankingAlerts = true;
  try {
    const { rows: alerts } = await pool.query(
      // LEFT JOIN em stores: com INNER, um anúncio sem store_id sumia do alerta
      // pra sempre (a linha nunca casava e nunca era marcada como notificada).
      `SELECT ra.id, ra.ranking_ad_id, ra.scheduled_at, ra.message,
              ad.ml_id, ad.title, ad.store_id, st.nickname AS store_nickname
       FROM ranking_ads_alerts ra
       JOIN ranking_ads ad ON ad.id = ra.ranking_ad_id
       LEFT JOIN stores st ON st.id = ad.store_id
       WHERE ra.notified_at IS NULL
         AND ra.scheduled_at <= NOW()
       ORDER BY ra.scheduled_at ASC
       LIMIT 100`
    );

    let count = 0;
    for (const alrt of alerts) {
      try {
        const title = escHtml(alrt.title || alrt.ml_id);
        const store = escHtml(alrt.store_nickname || '');
        const quando = new Date(alrt.scheduled_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
        const msg = `🔔 <b>Revisar ADS do anúncio</b>\n\n<b>${title}</b>\n<code>${alrt.ml_id}</code>${store ? `\n📦 ${store}` : ''}\n🗓️ Agendado para ${quando}${alrt.message ? `\n\n📝 ${escHtml(alrt.message)}` : ''}\n🔗 ${ranking.linkOf(alrt.ml_id)}`;

        // Dispara via Telegram (força, independente de silêncio/throttle).
        await tgNotifyForce('tg_rankeamento', msg);

        // Marca como notificado
        await pool.query(
          `UPDATE ranking_ads_alerts SET notified_at = NOW() WHERE id = $1`,
          [alrt.id]
        );
        count++;
      } catch (e) {
        console.error(`[sync-ranking-alerts] erro ao notificar alerta ${alrt.id}:`, e.message);
      }
    }

    if (count > 0) console.log(`[sync-ranking-alerts] ${count} alerta(s) disparado(s)`);
  } catch (e) {
    console.error('[sync-ranking-alerts] erro:', e.message);
  } finally {
    isSyncingRankingAlerts = false;
    // `scheduleEvery` é setTimeout de UMA vez: sem re-armar aqui, o job rodava
    // uma única vez depois do boot e nunca mais — todo aviso agendado depois
    // disso ficava parado no banco. Mesmo padrão dos demais jobs.
    scheduleEvery(1, syncRankingAlerts, 'sync-ranking-alerts');
  }
}

// Reconsulta em segundo plano o status das devoluções PENDENTES (claim status
// opened/analysis) — 1 GET por devolução, espaçado no tempo pra respeitar o
// rate limit apertado da API de claims do ML. Disparado manualmente pelo botão
// "Atualizar pendentes" (worker:cmd). Mesma disciplina de 429 do syncShippingStatus.
let isSyncingClaims = false;
async function syncClaimsStatus(manual = false) {
  if (isSyncingClaims) { console.warn('[sync-claims-status] já em execução — ignorando'); return; }
  isSyncingClaims = true;
  console.log('[sync-claims-status] iniciando reconsulta das devoluções pendentes...');
  try {
    const { rows: pending } = await pool.query(
      `SELECT id, store_id, order_id, title, amount, raw_data->>'id' AS claim_id FROM returns
       WHERE (status IN ('opened','analysis') OR status IS NULL)
         AND raw_data->>'id' IS NOT NULL
         AND date > now() - interval '120 days'
       ORDER BY updated_at ASC NULLS FIRST
       LIMIT 150`
    );
    await publish('devolucoes_sync_start', { total: pending.length });
    let updated = 0, errors = 0;
    const blockedStores = new Set();
    const streak = new Map();
    for (const r of pending) {
      if (blockedStores.has(r.store_id)) continue;
      let waitMs = 8000; // intervalo base entre chamadas (conservador — token compartilhado com webhooks)
      try {
        const claim = await ml.getClaim(r.claim_id, r.store_id);
        // Upsert por claim_id (grava a transição no histórico) em vez de UPDATE
        // por id — mantém o ponto único de gravação. orderId/amount vêm do que
        // já está na linha (r.order_id/r.amount); não recalcula (evita query extra).
        await upsertClaim({ storeId: r.store_id, orderId: r.order_id, buyerNickname: null, amount: r.amount, claim });
        updated++;
        streak.set(r.store_id, 0);
        // Saiu do estado pendente → devolução encerrada. Notifica UMA vez (na
        // próxima rodada ela já não é 'pendente', então não é reconsultada).
        if (claim.status && !['opened', 'analysis'].includes(claim.status)) {
          const labels = { closed: 'Encerrada', resolved: 'Resolvida', rejected: 'Rejeitada', cancelled: 'Cancelada', archived: 'Arquivada' };
          const rot = labels[claim.status] || claim.status;
          const loja = await getStoreName(r.store_id);
          await tgNotify('tg_devolucoes',
            `✅ <b>Devolução encerrada</b>\n🏪 Loja: ${loja}\n📦 Pedido: ${r.order_id||'—'}\n🏷️ Produto: ${r.title||'—'}\n📌 Status: ${rot}\n💰 Valor: R$ ${Number(r.amount||0).toFixed(2)}`
          ).catch(() => {});
        }
      } catch (e) {
        errors++;
        console.warn(`[sync-claims-status] erro return=${r.id} claim=${r.claim_id}: ${e.message}`);
        if (e.message?.includes('429')) {
          waitMs = 20000; // tomou 429 → espera bem mais antes da próxima
          const s = (streak.get(r.store_id) || 0) + 1;
          streak.set(r.store_id, s);
          if (s >= 3) { blockedStores.add(r.store_id); console.warn(`[sync-claims-status] loja ${r.store_id} — 3x 429, pausando o resto desta loja`); }
        }
      }
      await new Promise((res) => setTimeout(res, waitMs));
    }
    console.log(`[sync-claims-status] concluído: ${updated} atualizados, ${errors} erros (de ${pending.length})`);
    await publish('devolucoes_sync_done', { updated, errors, total: pending.length });
    // Resumo só no run manual (botão "Atualizar pendentes") — no automático não
    // spammar; o que interessa no automático é o alerta por devolução encerrada.
    if (manual) { try { await tgNotify('tg_devolucoes', `✅ <b>Devoluções atualizadas</b>\n🔄 ${updated} reconsultadas · ${errors} erro(s) · de ${pending.length} pendentes`); } catch {} }
    return { updated, errors, total: pending.length };
  } finally {
    isSyncingClaims = false;
  }
}

// ── Limpeza de vídeos de embalagem — retenção de 30 dias ────────────────
async function cleanupPackingVideos() {
  try {
    return await recordSync('cleanup-packing-videos', '30 3 * * *', async () => {
      const { rows } = await pool.query(
        `SELECT id, file_path FROM packing_videos WHERE created_at < now() - interval '30 days'`
      );
      let deleted = 0, errors = 0;
      for (const r of rows) {
        try {
          await fsp.unlink(r.file_path);
        } catch (e) {
          if (e.code !== 'ENOENT') { console.warn(`[cleanup-packing-videos] erro ao apagar ${r.file_path}:`, e.message); errors++; }
        }
        await pool.query(`DELETE FROM packing_videos WHERE id=$1`, [r.id]);
        deleted++;
      }
      console.log(`[cleanup-packing-videos] ${deleted} vídeo(s) removido(s), ${errors} erro(s)`);
      return { deleted, errors };
    });
  } finally {
    scheduleAt(3, 30, cleanupPackingVideos, 'cleanup-packing-videos');
  }
}

// Limpeza de webhook_logs — a tabela cresce sem limite (1 linha por webhook
// recebido; duplicados deduplicados pelo jobId ficam 'pending' pra sempre e
// nunca são processados). É só log/auditoria, então poda o que passou de 14
// dias em lotes (não trava a tabela). 03:45 diário. Ver decisions.md.
async function cleanupWebhookLogs() {
  try {
    return await recordSync('cleanup-webhook-logs', '45 3 * * *', async () => {
      let total = 0, r;
      do {
        r = await pool.query(
          `DELETE FROM webhook_logs WHERE id IN (
             SELECT id FROM webhook_logs WHERE received_at < now() - interval '14 days' LIMIT 20000
           )`
        );
        total += r.rowCount;
      } while (r.rowCount > 0);
      console.log(`[cleanup-webhook-logs] ${total} linha(s) antiga(s) removida(s)`);
      return { deleted: total };
    });
  } finally {
    scheduleAt(3, 45, cleanupWebhookLogs, 'cleanup-webhook-logs');
  }
}

// Backup do Postgres — pg_dump diário 02:30 (ver backup.js). Alerta Telegram
// (tg_backup, força) se falhar; o sino do topbar mostra o status/último arquivo.
const { runBackup: runDbBackup } = require('./backup');
async function backupDatabase() {
  try {
    return await recordSync('backup-database', '30 2 * * *', async () => {
      const st = await runDbBackup();
      if (!st.ok) {
        await tgNotifyForce('tg_backup', `🚨 <b>Backup do banco FALHOU</b>\n${st.error || 'erro desconhecido'}\nVerifique o servidor (pg_dump/espaço em disco).`).catch(() => {});
      }
      return st;
    });
  } finally {
    scheduleAt(2, 30, backupDatabase, 'backup-database');
  }
}

async function syncParentItems() {
  console.log('[syncParentItems] preenchendo parent_item_id via multiget...');
  // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);

  async function syncStoreParent(store) {
    const { rows: items } = await pool.query(
      `SELECT ml_id FROM items WHERE parent_item_id IS NULL AND store_id = $1`,
      [store.id]
    );
    const ids = items.map(r => r.ml_id);
    console.log(`[syncParentItems] ${store.nickname} → ${ids.length} itens`);
    let updated = 0;

    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      try {
        await new Promise(r => setTimeout(r, 30000)); // 30s entre lotes — não competir com webhooks
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
      } catch (e) {
        console.warn(`[syncParentItems] ${store.nickname} lote i=${i}:`, e.message);
        if (e.message?.includes('429')) await new Promise(r => setTimeout(r, 90000));
      }
      // delay extra após 429
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log(`[syncParentItems] ${store.nickname} → ${updated}/${ids.length} com parent_item_id`);
    return { updated, total: ids.length };
  }

  // Lojas em série para não saturar rate limit durante o processamento noturno
  const results = [];
  for (const store of stores) {
    try {
      const r = await syncStoreParent(store);
      results.push({ status: 'fulfilled', value: r });
    } catch (e) {
      results.push({ status: 'rejected', reason: e });
    }
    await new Promise(r => setTimeout(r, 30000)); // 30s entre lojas
  }
  const _results = results;
  const totals = _results.reduce((acc, r) => {
    if (r.status === 'fulfilled') { acc.updated += r.value.updated; acc.total += r.value.total; }
    return acc;
  }, { updated: 0, total: 0 });
  _results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[syncParentItems] ${stores[i].nickname} erro:`, r.reason?.message);
  });

  console.log(`[syncParentItems] concluído — ${totals.updated}/${totals.total} com parent_item_id`);
  await tgNotify('tg_infra', `✅ Sync parent_item_id concluído\n📦 ${totals.updated}/${totals.total} itens atualizados`).catch(() => {});
}

async function getTokenForStore(storeId) {
  const { rows } = await pool.query(`SELECT access_token FROM stores WHERE id=$1`, [storeId]);
  return rows[0]?.access_token;
}

// syncReturns retroativo: busca TODAS as páginas de devoluções (usado sob demanda, não no cron)
async function syncReturns() {
  console.log('[syncReturns] busca retroativa completa de devoluções...');
  // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
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
            const orderId = claimOrderId(claim);
            const buyerNickname = claim.players?.find(p => p.role === 'complainant')?.user_id?.toString() || null;
            await resolveClaimReason(claim.reason_id, store.id);
            const amount = await resolveReturnAmount(orderId);
            const up = await upsertClaim({ storeId: store.id, orderId, buyerNickname, amount, claim });
            if (up.isNew) total++;
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
    console.log(`[syncReturns] ${store.nickname} concluído`);
  }

  console.log(`[syncReturns] concluído — ${total} devoluções importadas`);
  await tgNotify('tg_devolucoes', `✅ Sync retroativo de devoluções concluído\n📦 ${total} registros importados`).catch(() => {});
}

// ── Sync Visitas — 02:00 diário, lojas sequenciais (evita 429 em lockstep) ───
// Lojas em paralelo (Promise.allSettled) faziam as 3 baterem no endpoint de
// visitas quase no mesmo instante; cada 429 pausava as 3 pelo mesmo tempo,
// então voltavam a tentar juntas e tomavam 429 de novo — em produção isso já
// causou 15+ min seguidos sem uma única chamada bem-sucedida (todas as 300
// tentativas de uma loja fadadas ao fracasso). Mesmo padrão de proteção já
// usado em syncScores para o mesmo tipo de rate limit do ML: loja por loja
// (sequencial) + circuit breaker de 5 429 consecutivos abortando a loja.
let isSyncingVisitas = false;

async function syncVisitas() {
  if (isSyncingVisitas) { console.warn('[sync-visitas] já em execução — ignorando'); return; }
  isSyncingVisitas = true;
  console.log('[sync-visitas] iniciando coleta de visitas...');

  try {
    return await recordSync('sync-visitas', '0 2 * * *', async () => {
      // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const lojaReport = [];

      for (const store of stores) {
        const { rows: activeItems } = await pool.query(
          `SELECT ml_id FROM items WHERE store_id=$1 AND status='active' LIMIT 300`, [store.id]
        );
        const ids = activeItems.map(r => r.ml_id);
        let visitasTotal = 0, errors = 0, consecutiveRateLimit = 0, aborted = false;
        console.log(`[sync-visitas] ${store.nickname} → ${ids.length} anúncios`);

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
            visitasTotal += total;
            consecutiveRateLimit = 0;
            if ((i + 1) % 20 === 0) console.log(`[sync-visitas] ${store.nickname} ${i+1}/${ids.length}`);
          } catch (e) {
            errors++;
            if (e.message?.includes('429') || e.message?.includes('rate limit')) {
              consecutiveRateLimit++;
              const waitMs = consecutiveRateLimit === 1 ? 60000 : 120000; // 1min na 1ª, 2min da 2ª em diante
              console.warn(`[sync-visitas] 429 ${store.nickname} item=${itemId} (${consecutiveRateLimit}ª seguida) — aguardando ${waitMs/1000}s`);
              await new Promise(r => setTimeout(r, waitMs));
              if (consecutiveRateLimit >= 5) {
                console.error(`[sync-visitas] ${store.nickname}: 5 rate limits seguidos — abortando loja (${i+1}/${ids.length} tentados)`);
                aborted = true;
                break;
              }
            } else {
              console.warn(`[sync-visitas] ${store.nickname} item=${itemId}: ${e.message}`);
            }
          }
          await new Promise(r => setTimeout(r, 20000));
        }
        console.log(`[sync-visitas] ${store.nickname} concluído — ${ids.length} itens, ${visitasTotal} visitas, ${errors} erros${aborted ? ' (abortado por rate limit)' : ''}`);
        lojaReport.push({ loja: store.nickname, itens: ids.length, visitas_total: visitasTotal, erros: errors, abortado: aborted });
        await new Promise(r => setTimeout(r, 5000)); // respiro entre lojas
      }

      const totalVisitas = lojaReport.reduce((s, l) => s + (l.visitas_total || 0), 0);
      console.log('[sync-visitas] coleta concluída');
      return { data_coletada: yesterday, total_visitas: totalVisitas, lojas: lojaReport };
    });
  } finally {
    isSyncingVisitas = false;
    scheduleAt(2, 0, syncVisitas, 'sync-visitas');
  }
}

// Verifica e renova tokens a cada 5 horas (independente do dailySync das 03:00)
async function tokenRefreshLoop() {
  console.log('[token-loop] verificando tokens...');
  try {
    // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML,
    // senão o loop as marca como "epoch zero" e manda alerta falso de reconexão no Telegram.
    const { rows: stores } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
    for (const store of stores) {
      const expiresIn = store.token_expires_at ? (new Date(store.token_expires_at) - Date.now()) : -1;

      // Se token está válido com mais de 4h, limpa do Set de expirados (reconexão manual)
      if (expiresIn >= 4 * 60 * 60 * 1000) {
        if (expiredStores.has(store.id)) {
          expiredStores.delete(store.id);
          console.log(`[token-loop] token válido após reconexão: ${store.nickname}`);
        }
        continue;
      }

      // Token permanentemente inválido (epoch zero) — NÃO tentar refresh, apenas notificar.
      // Tentativas de refresh em token epoch sempre retornam 400 do ML e reescrevem 1970-01-01,
      // destruindo qualquer reconexão manual feita simultaneamente pelo usuário.
      const tokenExpAt = store.token_expires_at ? new Date(store.token_expires_at) : null;
      if (!tokenExpAt || tokenExpAt.getFullYear() < 2000) {
        expiredStores.add(store.id);
        console.warn(`[token-loop] ${store.nickname} (${store.id}) token epoch zero — pulando refresh, reconexão manual necessária`);
        await tgNotify('tg_token', `❌ <b>Loja ${store.nickname} desconectada</b>\nToken permanentemente inválido.\nReconecte acessando:\n🔗 /auth/login?store_id=${store.id}`);
        continue;
      }

      // Renova se faltar menos de 4h ou já expirado — 4h dá margem para o loop de 30min
      if (expiresIn < 4 * 60 * 60 * 1000) {
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
}

// ── Sync Scores de Qualidade — 01:00 diário ──────────────────
let isSyncingScores = false;
async function syncScores() {
  if (isSyncingScores) { console.warn('[sync-scores] já em execução — ignorando'); return; }
  isSyncingScores = true;
  console.log('[sync-scores] iniciando sync de scores de qualidade...');
  try {
    return await recordSync('sync-scores', '0 1 * * *', async () => {
      // Exclui contas de outros marketplaces (Amazon/Shopee) — não têm token OAuth do ML.
  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);
      let totalSynced = 0, totalErrors = 0, totalSkipped = 0;
      const lojaReport = [];

      for (const store of stores) {
        try {
          await ensureTokenFresh(store);
          const { rows: items } = await pool.query(
            `SELECT ml_id, title, permalink FROM items WHERE store_id=$1 AND status='active' ORDER BY ml_id LIMIT 100`,
            [store.id]
          );
          console.log(`[sync-scores] ${store.nickname}: ${items.length} itens ativos`);
          let synced = 0, errors = 0, skipped = 0;

          let consecutiveRateLimit = 0;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
              let perf = null;
              // Tenta com 1 retry em caso de 429
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  perf = await ml.get(`/item/${item.ml_id}/performance`, store.id);
                  consecutiveRateLimit = 0;
                  break;
                } catch (e) {
                  // 400 = item sem score calculado pelo ML — trata como skipped, não erro
                  if (e.message?.includes('400')) {
                    perf = null;
                    break;
                  }
                  if (e.message?.includes('429') || e.message?.includes('rate limit')) {
                    consecutiveRateLimit++;
                    const waitMs = attempt === 0 ? 60000 : 120000;
                    console.warn(`[sync-scores] 429 em ${item.ml_id} (tentativa ${attempt+1}) — aguardando ${waitMs/1000}s`);
                    await new Promise(r => setTimeout(r, waitMs));
                    if (consecutiveRateLimit >= 5) {
                      console.error(`[sync-scores] ${store.nickname}: 5 rate limits seguidos — abortando loja`);
                      throw new Error('Rate limit persistente — abortado após 5 tentativas consecutivas');
                    }
                  } else {
                    throw e;
                  }
                }
              }

              if (!perf || perf.error) { skipped++; continue; }

              const score   = perf.score ?? null;
              const level   = perf.level?.id ?? null;
              const wording = perf.level?.wording ?? null;
              const buckets = perf.groups || perf.buckets || [];
              const pending = Array.isArray(buckets)
                ? buckets.reduce((a, g) => a + (Array.isArray(g.variables)
                  ? g.variables.filter(v => v.status === 'PENDING').length : 0), 0)
                : 0;
              const calcAt  = perf.last_update ? new Date(perf.last_update) : null;

              await pool.query(
                `INSERT INTO item_performance (store_id, item_id, score, level, level_wording, pending_count, buckets, calculated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (item_id) DO UPDATE SET
                   score=EXCLUDED.score, level=EXCLUDED.level, level_wording=EXCLUDED.level_wording,
                   pending_count=EXCLUDED.pending_count, buckets=EXCLUDED.buckets,
                   calculated_at=EXCLUDED.calculated_at, synced_at=now()`,
                [store.id, item.ml_id, score, level, wording, pending, JSON.stringify(buckets), calcAt]
              );
              synced++;

              if (score != null) {
                const problems = Array.isArray(buckets)
                  ? buckets.flatMap(g => Array.isArray(g.variables)
                    ? g.variables.filter(v => v.status === 'PENDING').map(v => v.name || v.id)
                    : [])
                  : [];
                const qualityTask = await taskEngine.checkQuality({
                  itemId: item.ml_id, title: item.title, score, problems,
                  permalink: item.permalink, storeId: store.id, storeName: store.nickname,
                });
                if (qualityTask?.created) await publish('task_created', { id: qualityTask.id, rule_key: 'score_baixo', title: 'Melhorar qualidade do anúncio' });
              }
            } catch (e) {
              if (e.message?.includes('Rate limit persistente')) throw e; // propaga para abortar loja
              console.warn(`[sync-scores] erro em ${item.ml_id}: ${e.message}`);
              errors++;
            }
            // 10s entre itens
            await new Promise(r => setTimeout(r, 10000));
            // A cada 10 itens, pausa extra de 30s
            if ((i + 1) % 10 === 0) {
              console.log(`[sync-scores] ${store.nickname}: lote ${Math.ceil((i+1)/10)} concluído (${i+1}/${items.length}) — pausa 30s`);
              await new Promise(r => setTimeout(r, 30000));
            }
          }

          totalSynced  += synced;
          totalErrors  += errors;
          totalSkipped += skipped;
          lojaReport.push({ loja: store.nickname, synced, errors, skipped });
          console.log(`[sync-scores] ${store.nickname}: ${synced} ok, ${errors} erros, ${skipped} sem score`);
          await new Promise(r => setTimeout(r, 3000)); // 3s entre lojas
        } catch (e) {
          console.error(`[sync-scores] erro na loja ${store.nickname}:`, e.message);
          lojaReport.push({ loja: store.nickname, erro: e.message });
        }
      }

      console.log(`[sync-scores] concluído: ${totalSynced} atualizados, ${totalErrors} erros, ${totalSkipped} sem score`);
      return { synced: totalSynced, errors: totalErrors, skipped: totalSkipped, lojas: lojaReport };
    });
  } finally {
    isSyncingScores = false;
    scheduleAt(1, 0, syncScores, 'sync-scores');
  }
}

// ── Sync Notion Tarefas — Segunda-feira 08:00 ────────────────────────────────
// Avalia anúncios com baixa performance (0 vendas nos últimos 30 dias)
// e cria tarefas no Notion database configurado em NOTION_DATABASE_ID.
let isSyncingNotion = false;

async function syncNotionTarefas() {
  if (isSyncingNotion) { console.warn('[notion] já em execução — ignorando'); return; }
  isSyncingNotion = true;

  try {
    return await recordSync('sync-notion', '0 8 * * 1', async () => {
      const notion = require('./notionClient');
      if (!notion.isConfigured()) {
        console.warn('[notion] NOTION_TOKEN ou NOTION_DATABASE_ID não configurados — pulando');
        return { criadas: 0, duplicadas: 0, erro: 'not_configured' };
      }

      // Busca anúncios ativos com estoque mas sem vendas nos últimos 30 dias
      const { rows: salesRows } = await pool.query(`
        SELECT
          COALESCE(item_id, raw_data->'order_items'->0->'item'->>'id') as iid,
          store_id,
          SUM(CASE WHEN date_created >= CURRENT_DATE - 30 THEN COALESCE(quantity,1) ELSE 0 END) as qtd_30d
        FROM orders
        WHERE status != 'cancelled'
        GROUP BY 1, 2
      `);
      const salesMap = {};
      salesRows.forEach(r => { if (r.iid) salesMap[`${r.store_id}:${r.iid}`] = Number(r.qtd_30d); });

      const { rows: items } = await pool.query(`
        SELECT i.ml_id, i.store_id,
               COALESCE(s.nickname, 'Loja '||i.store_id::text) as loja,
               i.title, i.price, i.available_quantity as estoque,
               i.sold_quantity, i.permalink
        FROM items i
        LEFT JOIN stores s ON s.id = i.store_id
        WHERE i.status = 'active' AND i.available_quantity > 0
        ORDER BY i.price * i.available_quantity DESC
        LIMIT 2000
      `);

      // Classifica: 0 vendas = parado, 1-3 = baixo, >3 = ok
      const parados = items.filter(i => (salesMap[`${i.store_id}:${i.ml_id}`] || 0) === 0);
      const baixos  = items.filter(i => { const v = salesMap[`${i.store_id}:${i.ml_id}`] || 0; return v >= 1 && v <= 3; });

      console.log(`[notion] ${parados.length} parados, ${baixos.length} com vendas baixas`);

      const prazo = new Date();
      prazo.setDate(prazo.getDate() + 7);
      const prazoStr = prazo.toISOString().slice(0, 10);

      let criadas = 0, duplicadas = 0, erros = 0;

      // Cria tarefas para anúncios parados (prioridade alta)
      for (const item of parados.slice(0, 20)) {
        try {
          const titulo = item.ml_id;
          const existente = await notion.buscarTarefaExistente(titulo);
          if (existente) { duplicadas++; continue; }

          const capital = (Number(item.price) * Number(item.estoque)).toFixed(0);
          await notion.criarTarefa({
            title: `📢 Avaliar anúncio parado: ${item.title.slice(0, 80)}`,
            prazo: prazoStr,
            fonte: 'ML Dashboard — Estoque Parado',
            content:
              `🏪 Loja: ${item.loja}\n` +
              `🆔 MLB: ${item.ml_id}\n` +
              `💰 Preço: R$ ${Number(item.price).toFixed(2)}\n` +
              `📦 Estoque: ${item.estoque} unidades (capital parado: R$ ${capital})\n` +
              `📉 Vendas nos últimos 30 dias: 0\n` +
              `📊 Total histórico de vendas: ${item.sold_quantity}\n` +
              `🔗 Anúncio: ${item.permalink || 'https://produto.mercadolivre.com.br/' + item.ml_id.replace(/^MLB(\d)/, 'MLB-$1')}\n\n` +
              `Ações sugeridas:\n- Revisar título e fotos\n- Verificar preço frente à concorrência\n- Considerar promoção ou redução de preço`,
          });
          criadas++;
          await new Promise(r => setTimeout(r, 400)); // respeita rate limit Notion
        } catch (e) {
          console.error(`[notion] erro ao criar tarefa para ${item.ml_id}:`, e.message);
          erros++;
        }
      }

      // Cria tarefas para anúncios com vendas baixas (1-3/mês)
      for (const item of baixos.slice(0, 10)) {
        try {
          const existente = await notion.buscarTarefaExistente(item.ml_id);
          if (existente) { duplicadas++; continue; }

          const vendas30d = salesMap[`${item.store_id}:${item.ml_id}`] || 0;
          await notion.criarTarefa({
            title: `⚠️ Anúncio com vendas baixas: ${item.title.slice(0, 75)}`,
            prazo: prazoStr,
            fonte: 'ML Dashboard — Baixas Vendas',
            content:
              `🏪 Loja: ${item.loja}\n` +
              `🆔 MLB: ${item.ml_id}\n` +
              `💰 Preço: R$ ${Number(item.price).toFixed(2)}\n` +
              `📦 Estoque: ${item.estoque} unidades\n` +
              `📉 Vendas nos últimos 30 dias: ${vendas30d}\n` +
              `📊 Total histórico de vendas: ${item.sold_quantity}\n` +
              `🔗 Anúncio: ${item.permalink || 'https://produto.mercadolivre.com.br/' + item.ml_id.replace(/^MLB(\d)/, 'MLB-$1')}\n\n` +
              `Ações sugeridas:\n- Otimizar título com palavras-chave de busca\n- Melhorar descrição e imagens\n- Avaliar anúncio patrocinado`,
          });
          criadas++;
          await new Promise(r => setTimeout(r, 400));
        } catch (e) {
          console.error(`[notion] erro ao criar tarefa para ${item.ml_id}:`, e.message);
          erros++;
        }
      }

      console.log(`[notion] concluído: ${criadas} tarefas criadas, ${duplicadas} duplicadas ignoradas, ${erros} erros`);
      if (criadas > 0) {
        await tgNotify('tg_infra',
          `📋 <b>Notion — Tarefas de Anúncios</b>\n✅ ${criadas} tarefas criadas\n` +
          `⏭ ${duplicadas} já existiam\n📢 ${parados.length} anúncios parados detectados`
        ).catch(() => {});
      }

      return { criadas, duplicadas, erros, parados: parados.length, baixos: baixos.length };
    });
  } finally {
    isSyncingNotion = false;
    // Segunda-feira 08:00
    const now = new Date();
    const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(8, 0, 0, 0);
    const msUntil = nextMonday - now;
    setTimeout(() => syncNotionTarefas().catch(e => console.error('[notion] erro agendado:', e.message)), msUntil);
    console.log(`[notion] próxima execução: ${nextMonday.toLocaleString('pt-BR')}`);
  }
}

// ── Agendadores de boot ───────────────────────────────────────
// Sync Scores   → 01:00  (scores de qualidade dos anúncios)
// Sync Vendas   → 03:00  (pedidos 72h)
// Sync Métricas → 04:15  (reputação + devoluções recentes)
// Sync Visitas  → 02:00  (visitas por anúncio)
// ── Resumo Diário — 23:59 ────────────────────────────────────────────────────
// Reaproveitada por resumoDiario (Telegram) e emailDailyReports (e-mail) —
// mesma consulta, dois canais de saída. Não duplicar a query nos dois lugares.
async function resumoDiario() {
  console.log('[resumo-diario] gerando resumo do dia...');
  try {
    const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
    const { porLoja, porLog } = await getResumoDiarioData();

    if (!porLoja.length) {
      await tgNotifyForce('tg_resumo', '📊 <b>Resumo do Dia</b>\n\nNenhum pedido registrado hoje.');
      scheduleAt(6, 0, resumoDiario, 'resumo-diario');
      return;
    }

    const totalPedidos = porLoja.reduce((a, r) => a + Number(r.pedidos), 0);
    const totalReceita = porLoja.reduce((a, r) => a + Number(r.receita), 0);
    const totalItens   = porLoja.reduce((a, r) => a + Number(r.itens),   0);

    const ontem = new Date(Date.now() - 86400000).toLocaleDateString('pt-BR');
    let msg = `📊 <b>Resumo do Dia — ${ontem}</b>\n\n`;

    msg += `📦 <b>Total:</b> ${totalPedidos} pedidos | ${totalItens} itens\n`;
    msg += `💰 <b>Receita:</b> ${Rfmt(totalReceita)}\n\n`;

    msg += `🏪 <b>Por Loja:</b>\n`;
    for (const r of porLoja) {
      msg += `  • ${r.nickname}: ${r.pedidos} pedidos — ${Rfmt(r.receita)}\n`;
    }

    msg += `\n🚚 <b>Por Logística:</b>\n`;
    const logLabel = t => fmtLogistica(t);
    for (const r of porLog) {
      msg += `  • ${logLabel(r.tipo)}: ${r.pedidos} pedidos\n`;
    }

    await tgNotifyForce('tg_resumo', msg);
    console.log('[resumo-diario] enviado');
  } catch (e) {
    console.error('[resumo-diario] erro:', e.message);
  }
  scheduleAt(6, 0, resumoDiario, 'resumo-diario');
}

// ── Fechamento financeiro diário — lucro REAL (Margem de Contribuição) ──────
// 06:05, depois do mp-reports (05:40) pra pegar a conciliação fresca do dia
// anterior. Manda por loja: Aprovadas, Custos, Margem e MC%. Alerta (⚠️) as
// lojas com MC% abaixo do limite (app_config 'mc_pct_min', fallback env
// MC_PCT_MIN, default 8%). Usa getMargemPorLoja (mesma fonte da tela). Ver
// finance.md e business-rules.md.
async function fechamentoDiario() {
  console.log('[fechamento-diario] gerando fechamento de ontem...');
  try {
    const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
    const y = new Date(Date.now() - 86400000);
    const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const ontem = y.toLocaleDateString('pt-BR');

    const lojas = (await getMargemPorLoja({ dateFrom: yStr, dateTo: yStr }))
      .filter(l => l.aprovadas > 0);

    if (!lojas.length) {
      await tgNotifyForce('tg_fechamento', `💵 <b>Fechamento — ${ontem}</b>\n\nNenhuma venda aprovada ontem.`);
      scheduleAt(6, 5, fechamentoDiario, 'fechamento-diario');
      return;
    }

    const { rows: cfgRows } = await pool.query(`SELECT value FROM app_config WHERE key='mc_pct_min'`);
    const mcMin = Number(cfgRows[0]?.value ?? process.env.MC_PCT_MIN ?? 8);

    const totAprov = lojas.reduce((a, l) => a + l.aprovadas, 0);
    const totMargem = lojas.reduce((a, l) => a + l.margem, 0);
    const totPct = totAprov > 0 ? (totMargem / totAprov * 100) : 0;

    let msg = `💵 <b>Fechamento — ${ontem}</b>\n`;
    msg += `Lucro real (Margem de Contribuição), por loja:\n\n`;
    msg += `📊 <b>Consolidado:</b> ${Rfmt(totAprov)} aprovado → <b>${Rfmt(totMargem)}</b> (${totPct.toFixed(1)}%)\n\n`;

    const baixas = [];
    for (const l of lojas) {
      const custos = l.custo + l.imposto + l.tarifa + l.frete_vendedor;
      const alerta = l.margem_pct < mcMin;
      if (alerta) baixas.push(l);
      msg += `${alerta ? '⚠️ ' : '🏪 '}<b>${l.loja}</b>\n`;
      msg += `   Aprovadas ${Rfmt(l.aprovadas)} · Custos ${Rfmt(custos)}\n`;
      msg += `   Margem <b>${Rfmt(l.margem)}</b> (${l.margem_pct.toFixed(1)}%)${!l.tem_conciliacao ? ' · <i>taxa estimada</i>' : ''}\n`;
    }
    if (baixas.length) {
      msg += `\n⚠️ <b>MC% abaixo de ${mcMin}%:</b> ${baixas.map(l => `${l.loja} (${l.margem_pct.toFixed(1)}%)`).join(', ')}`;
    }

    await tgNotifyForce('tg_fechamento', msg);
    console.log('[fechamento-diario] enviado');
  } catch (e) {
    console.error('[fechamento-diario] erro:', e.message);
  }
  scheduleAt(6, 5, fechamentoDiario, 'fechamento-diario');
}

// ── Ruptura iminente — alerta diário (07:30) ────────────────────────────────
// Item que vende bem e vai acabar (dias_restantes < 7). Reaproveita
// getRupturaEstoque (mesma fonte da página Reposição). Ver business-rules.md.
async function checkRupturaEstoque() {
  try {
    return await recordSync('ruptura-estoque', '30 7 * * *', async () => {
      const { items } = await getRupturaEstoque({ dias: 7 });
      if (!items.length) return { alertados: 0 };
      const top = items.slice(0, 12);
      let msg = `🔥 <b>Ruptura iminente</b> — vende bem e vai acabar:\n\n`;
      for (const it of top) {
        const t = (it.title || it.ml_id).slice(0, 45);
        msg += `⏳ <b>${it.dias_restantes}d</b> · ${it.stock} un · ${it.venda_dia}/dia\n${t}${it.sugestao_compra > 0 ? ` · comprar +${it.sugestao_compra}` : ''}\n`;
      }
      if (items.length > top.length) msg += `\n… e mais ${items.length - top.length} anúncio(s).`;
      await tgNotify('tg_reposicao', msg);
      return { alertados: items.length };
    });
  } finally {
    scheduleAt(7, 30, checkRupturaEstoque, 'ruptura-estoque');
  }
}

// ── Relatórios por e-mail (Resend) ────────────────────────────────────────
// Credencial só via .env (RESEND_API_KEY/RESEND_FROM_EMAIL/RESEND_TO_EMAIL,
// ver resendClient.js) — o que é configurável pela UI (Monitor) é só o
// toggle liga/desliga de cada relatório (app_config: email_resumo,
// email_topvendas, email_semanal), lido aqui antes de enviar.
function emailWrap(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
      <div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <h1 style="font-size:20px;margin:0 0 4px;color:#111;">${title}</h1>
        <p style="font-size:12px;color:#888;margin:0 0 20px;">ML Dashboard Multimarcas</p>
        ${bodyHtml}
      </div>
      <p style="text-align:center;font-size:11px;color:#aaa;margin-top:16px;">Enviado automaticamente pelo ML Dashboard</p>
    </div>
  </body></html>`;
}

function emailTable(headers, rows) {
  const th = headers.map(h => `<th style="text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;color:#888;border-bottom:2px solid #eee;">${h}</th>`).join('');
  const tr = rows.map(r => `<tr>${r.map(c => `<td style="padding:8px 10px;font-size:13px;border-bottom:1px solid #f0f0f0;color:#333;">${c}</td>`).join('')}</tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0;"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

// Só envia se o toggle correspondente estiver ligado em app_config — mesma
// ideia do tgNotify (tópico desativável), mas sem janela de silêncio/throttle
// (relatórios por e-mail já são de baixa frequência por natureza).
async function sendReportEmail(topicKey, subject, bodyHtml) {
  try {
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [topicKey]);
    if (rows[0]?.value !== 'true') return;

    const resend = require('./resendClient');
    if (!resend.isConfigured()) {
      console.warn(`[email] ${topicKey} habilitado mas RESEND_API_KEY/RESEND_TO_EMAIL não configurados no .env`);
      return;
    }
    await resend.sendEmail({ subject, html: emailWrap(subject, bodyHtml) });
    console.log(`[email] enviado: ${subject}`);
  } catch (e) {
    console.error(`[email] erro ao enviar "${subject}":`, e.message);
  }
}

// Resumo diário + Top vendas do dia — mesmo horário de resumoDiario (06:00
// Telegram), 10 min depois, pra não competir pela mesma janela de queries.
async function emailDailyReports() {
  console.log('[email-diario] gerando relatórios do dia...');
  const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
  const ontem = new Date(Date.now() - 86400000).toLocaleDateString('pt-BR');

  try {
    const { porLoja, porLog } = await getResumoDiarioData();
    if (porLoja.length) {
      const totalPedidos = porLoja.reduce((a, r) => a + Number(r.pedidos), 0);
      const totalReceita = porLoja.reduce((a, r) => a + Number(r.receita), 0);
      const totalItens   = porLoja.reduce((a, r) => a + Number(r.itens),   0);

      const html = `
        <p style="font-size:14px;color:#333;">📅 ${ontem}</p>
        <div style="display:flex;gap:16px;margin:16px 0;">
          <div style="flex:1;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Pedidos</div>
            <div style="font-size:22px;font-weight:700;">${totalPedidos}</div>
          </div>
          <div style="flex:1;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Receita</div>
            <div style="font-size:22px;font-weight:700;">${Rfmt(totalReceita)}</div>
          </div>
          <div style="flex:1;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Itens</div>
            <div style="font-size:22px;font-weight:700;">${totalItens}</div>
          </div>
        </div>
        <h3 style="font-size:14px;margin:20px 0 4px;">Por loja</h3>
        ${emailTable(['Loja', 'Pedidos', 'Receita'], porLoja.map(r => [r.nickname, r.pedidos, Rfmt(r.receita)]))}
        <h3 style="font-size:14px;margin:20px 0 4px;">Por logística</h3>
        ${emailTable(['Tipo', 'Pedidos'], porLog.map(r => [fmtLogistica(r.tipo), r.pedidos]))}
      `;
      await sendReportEmail('email_resumo', `Resumo do Dia — ${ontem}`, html);
    }
  } catch (e) {
    console.error('[email-diario] erro no resumo:', e.message);
  }

  try {
    // Top vendas do e-mail cobre 24h (não 4h como o alerta do Telegram) —
    // faz mais sentido como "melhores do dia" num digest diário.
    const rows = await getTopVendas({ hours: 24, limit: 10 });
    if (rows.length) {
      const html = emailTable(
        ['#', 'Loja', 'Item', 'Unidades', 'Receita'],
        rows.map((r, i) => [i + 1, r.loja || '—', r.title || r.item_id, r.unidades, Rfmt(r.receita)])
      );
      await sendReportEmail('email_topvendas', `Top Vendas do Dia — ${ontem}`, html);
    }
  } catch (e) {
    console.error('[email-diario] erro no top vendas:', e.message);
  }

  scheduleAt(6, 10, emailDailyReports, 'email-diario');
}

// Relatório semanal completo — toda 2ª-feira 07:00: vendas do período (7d)
// vs período anterior (7d antes disso), por loja, e curva ABC (top 10 por
// faturamento). Fórmula de margem idêntica à de GET /api/vendas/detalhado
// (ver .claude/finance.md) — não reinventar outra fórmula aqui.
async function emailRelatorioSemanal() {
  console.log('[email-semanal] gerando relatório semanal...');
  const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
  const Pfmt = v => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

  try {
    const resumo = await getResumoSemanal();
    const { atual, anterior, variacao, por_loja: porLoja, curva_abc: abc } = resumo;

    if (!porLoja.length) {
      console.log('[email-semanal] nenhum pedido nos últimos 7 dias — nada a enviar');
    } else {
      const de = new Date(Date.now() - 7 * 86400000).toLocaleDateString('pt-BR');
      const ate = new Date().toLocaleDateString('pt-BR');

      const html = `
        <p style="font-size:14px;color:#333;">📅 ${de} — ${ate} (vs. 7 dias anteriores)</p>
        <div style="display:flex;gap:16px;margin:16px 0;flex-wrap:wrap;">
          <div style="flex:1;min-width:130px;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Pedidos</div>
            <div style="font-size:22px;font-weight:700;">${atual.pedidos}</div>
            <div style="font-size:12px;color:${variacao.pedidos_pct >= 0 ? '#27ae60' : '#e74c3c'};">${Pfmt(variacao.pedidos_pct)}</div>
          </div>
          <div style="flex:1;min-width:130px;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Receita</div>
            <div style="font-size:22px;font-weight:700;">${Rfmt(atual.receita)}</div>
            <div style="font-size:12px;color:${variacao.receita_pct >= 0 ? '#27ae60' : '#e74c3c'};">${Pfmt(variacao.receita_pct)}</div>
          </div>
          <div style="flex:1;min-width:130px;background:#f8f8f8;border-radius:8px;padding:12px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;">Margem</div>
            <div style="font-size:22px;font-weight:700;">${Rfmt(atual.margem)}</div>
            <div style="font-size:12px;color:#888;">${atual.mc_pct.toFixed(1)}% MC</div>
          </div>
        </div>
        <h3 style="font-size:14px;margin:20px 0 4px;">Por loja</h3>
        ${emailTable(['Loja', 'Pedidos', 'Receita'], porLoja.map(r => [r.nickname, r.pedidos, Rfmt(r.receita)]))}
        <h3 style="font-size:14px;margin:20px 0 4px;">Curva ABC — top 10 por faturamento</h3>
        ${emailTable(['Item', 'Faturamento', 'Curva'], abc.map(r => [r.title || r.item_id, Rfmt(r.faturamento), r.curva]))}
      `;
      await sendReportEmail('email_semanal', `Relatório Semanal — ${de} a ${ate}`, html);
    }
  } catch (e) {
    console.error('[email-semanal] erro:', e.message);
  }

  scheduleWeekly(1, 7, 0, emailRelatorioSemanal, 'email-semanal');
}

// ── Outlier estatístico — 06:20 diário, compara ontem com a média histórica ─
// Mesma lógica de `media_historica`/`banda_min`/`banda_max` da página
// "Análise de Vendas do Mês" (GET /api/analises/vendas-mes), reimplementada
// aqui porque o worker fala só com o Postgres, nunca com a própria API HTTP
// do server (ver decisions.md). Limiar de alerta é ±1.5 desvio-padrão —
// mais largo que a banda de ±1 desvio mostrada no gráfico (que é só "faixa
// normal" visual, não gatilho de alerta) — evita notificar toda vez que um
// dia sai um pouco da média, o que aconteceria com frequência.
async function checkOutlierEstatistico() {
  console.log('[outlier] verificando outliers estatísticos...');
  try {
    const outliers = await getOutliersOntem();
    const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

    for (const o of outliers) {
      await tgNotify('tg_outlier',
        `${o.acima ? '🚀' : '⚠️'} <b>Dia fora do padrão — ${o.nickname}</b>\n` +
        `📅 Ontem (dia ${o.dia_do_mes}) fechou ${o.acima ? 'muito acima' : 'muito abaixo'} da média histórica\n` +
        `💰 Receita: ${Rfmt(o.receita_ontem)} (média: ${Rfmt(o.media)}, ${o.diff_pct >= 0 ? '+' : ''}${o.diff_pct}%)\n` +
        `📊 Baseado em ${o.meses_analisados} mês(es) de histórico`
      );
    }
  } catch (e) {
    console.error('[outlier] erro:', e.message);
  }
  scheduleAt(6, 20, checkOutlierEstatistico, 'outlier-check');
}

// ── Taxa de devolução alta — 06:30 diário ─────────────────────────────────
// Mesma fórmula do card "Taxa de Devolução" de pages/devolucoes.html
// (devoluções ÷ pedidos × 100), mas em janela fixa de últimas 24h por loja
// ML, não o filtro livre da tela. TAXA_DEVOLUCAO_ALERTA_PCT e
// TAXA_DEVOLUCAO_AMOSTRA_MIN são limiares fixos (ver business-rules.md) —
// lojas com poucos pedidos no dia (< amostra mínima) são ignoradas pra não
// gerar alerta de "100% de devolução" com 1 pedido e 1 devolução.
const TAXA_DEVOLUCAO_ALERTA_PCT = 5;
const TAXA_DEVOLUCAO_AMOSTRA_MIN = 10;
async function checkTaxaDevolucaoAlta() {
  console.log('[taxa-devolucao] verificando taxa de devolução por loja...');
  try {
    const { rows } = await pool.query(
      `WITH pedidos AS (
         SELECT store_id, COUNT(*) AS n
         FROM orders
         WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML')
           AND status != 'cancelled' AND date_created >= now() - interval '1 day'
         GROUP BY store_id
       ), devol AS (
         SELECT store_id, COUNT(*) AS n
         FROM returns
         WHERE date >= now() - interval '1 day'
         GROUP BY store_id
       )
       SELECT s.id AS store_id, s.nickname, COALESCE(d.n, 0) AS devolucoes, p.n AS pedidos
       FROM stores s
       JOIN pedidos p ON p.store_id = s.id
       LEFT JOIN devol d ON d.store_id = s.id
       WHERE s.marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML')`
    );
    for (const r of rows) {
      const pedidos = Number(r.pedidos), devolucoes = Number(r.devolucoes);
      if (pedidos < TAXA_DEVOLUCAO_AMOSTRA_MIN) continue;
      const taxaPct = (devolucoes / pedidos) * 100;
      if (taxaPct < TAXA_DEVOLUCAO_ALERTA_PCT) continue;
      await tgNotify('tg_devolucoes',
        `📉 <b>Taxa de devolução alta — ${r.nickname}</b>\n` +
        `↩️ ${devolucoes} devolução(ões) em ${pedidos} pedido(s) (últimas 24h)\n` +
        `📊 Taxa: ${taxaPct.toFixed(2)}% (limite: ${TAXA_DEVOLUCAO_ALERTA_PCT}%)`
      );
    }
  } catch (e) {
    console.error('[taxa-devolucao] erro:', e.message);
  }
  scheduleAt(6, 30, checkTaxaDevolucaoAlta, 'taxa-devolucao');
}

// ── Conciliação Bancária: divergências — 05:25 diário ─────────────────────
// Dois tipos de alerta, numa única mensagem consolidada (mesmo padrão de
// checkTarefasAtrasadas): (1) diferença bruto/líquido anormalmente alta —
// limiar fixo inicial (ver business-rules.md), sem base histórica ainda pra
// calcular um limiar estatístico como o outlier de vendas; (2) pagamento
// passou da money_release_date esperada (+ margem de folga) e continua
// released='no' — sinal de que a liberação não aconteceu como previsto.
// Dedup via alert_notified_at (v32) — notifica 1x por pagamento, nunca repete.
const CONCILIACAO_DIFERENCA_ALERTA_PCT = 50;   // diferença > 50% do valor bruto
const CONCILIACAO_LIBERACAO_ATRASO_DIAS = 2;   // dias de folga após money_release_date

async function checkConciliacaoDivergencias() {
  console.log('[conciliacao-divergencias] verificando pagamentos...');
  const fmtMoeda = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
  try {
    const { rows: divergentes } = await pool.query(
      `SELECT payment_id, order_id, transaction_amount, net_received_amount,
              (transaction_amount - COALESCE(net_received_amount, transaction_amount)) AS diferenca
       FROM ml_payments
       WHERE alert_notified_at IS NULL
         AND net_received_amount IS NOT NULL
         AND transaction_amount > 0
         AND (transaction_amount - net_received_amount) / transaction_amount * 100 >= $1
       ORDER BY date_approved DESC LIMIT 30`,
      [CONCILIACAO_DIFERENCA_ALERTA_PCT]
    );
    const { rows: atrasados } = await pool.query(
      `SELECT payment_id, order_id, money_release_date
       FROM ml_payments
       WHERE alert_notified_at IS NULL
         AND released IS DISTINCT FROM 'yes'
         AND money_release_date IS NOT NULL
         AND money_release_date < now() - ($1 || ' days')::interval
       ORDER BY money_release_date ASC LIMIT 30`,
      [CONCILIACAO_LIBERACAO_ATRASO_DIAS]
    );

    if (divergentes.length || atrasados.length) {
      let msg = `⚠️ <b>Conciliação Bancária — divergências encontradas</b>\n`;
      if (divergentes.length) {
        msg += `\n💸 <b>Diferença alta (≥${CONCILIACAO_DIFERENCA_ALERTA_PCT}% do bruto)</b>\n`;
        msg += divergentes.map(d => `• Pedido ${d.order_id}: ${fmtMoeda(d.transaction_amount)} → ${fmtMoeda(d.net_received_amount)} (dif. ${fmtMoeda(d.diferenca)})`).join('\n') + '\n';
      }
      if (atrasados.length) {
        msg += `\n⏳ <b>Liberação atrasada (+${CONCILIACAO_LIBERACAO_ATRASO_DIAS}d)</b>\n`;
        msg += atrasados.map(a => `• Pedido ${a.order_id}: esperado ${new Date(a.money_release_date).toLocaleDateString('pt-BR')}`).join('\n') + '\n';
      }
      await tgNotify('tg_conciliacao', msg);

      const ids = [...divergentes.map(d => d.payment_id), ...atrasados.map(a => a.payment_id)];
      await pool.query(`UPDATE ml_payments SET alert_notified_at = now() WHERE payment_id = ANY($1)`, [ids]);
    }
  } catch (e) {
    console.error('[conciliacao-divergencias] erro:', e.message);
  }
  scheduleAt(5, 25, checkConciliacaoDivergencias, 'conciliacao-divergencias');
}

// ── Tarefas atrasadas (Agenda Trello) — 08:15 diário ──────────────────────
// Notifica 1x por vencimento (overdue_notified_at, v27) — não repete o
// mesmo alerta todo dia enquanto o cartão continuar atrasado. Reseta quando
// o prazo é adiado (ver PATCH /api/tasks/:id). 1 mensagem consolidada, não
// 1 por tarefa, pra não gerar spam se várias vencerem no mesmo dia.
async function checkTarefasAtrasadas() {
  console.log('[tarefas-atrasadas] verificando prazos vencidos...');
  try {
    const { rows } = await pool.query(
      `SELECT id, title, due_date, priority, assigned_to
       FROM tasks
       WHERE due_date < now() AND board_column NOT IN ('finalizado','excluido') AND overdue_notified_at IS NULL
       ORDER BY due_date ASC LIMIT 50`
    );
    if (rows.length) {
      const linhas = rows.map(t => {
        const dias = Math.floor((Date.now() - new Date(t.due_date).getTime()) / 86400000);
        const prio = t.priority === 'alta' ? '🔴' : t.priority === 'media' ? '🟡' : '⚪';
        return `${prio} ${t.title}${t.assigned_to ? ` (${t.assigned_to})` : ''} — ${dias}d atrasado`;
      });
      await tgNotify('tg_tarefas',
        `⏰ <b>${rows.length} tarefa(s) atrasada(s) na Agenda Trello</b>\n\n${linhas.join('\n')}`
      );
      await pool.query(`UPDATE tasks SET overdue_notified_at = now() WHERE id = ANY($1)`, [rows.map(t => t.id)]);
    }
  } catch (e) {
    console.error('[tarefas-atrasadas] erro:', e.message);
  }
  scheduleAt(8, 15, checkTarefasAtrasadas, 'tarefas-atrasadas');
}

// ── Top Vendas — a cada 4h, ranking de itens mais vendidos por loja ──────
// Objetivo: dar visibilidade rápida do que está vendendo bem "agora" (janela
// de 4h, não acumulado do dia) para decisão de reposição de estoque — ver
// .claude/business-rules.md.
let isSyncingTopVendas = false;

async function syncTopVendas() {
  if (isSyncingTopVendas) { console.warn('[top-vendas] já em execução — ignorando'); return; }
  isSyncingTopVendas = true;
  console.log('[top-vendas] verificando itens mais vendidos...');

  try {
    return await recordSync('top-vendas', '0 */4 * * *', async () => {
      const Rfmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

      const rows = await getTopVendas({ hours: 4, limit: 5 });

      if (!rows.length) {
        console.log('[top-vendas] nenhuma venda nas últimas 4h — nada a notificar');
        return { itens: 0 };
      }

      const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
      let msg = `📈 <b>Top Vendas — últimas 4h</b>\n🕐 ${agora}\n\n`;
      rows.forEach((r, i) => {
        msg += `${i + 1}. 🏪 <b>${r.loja || '—'}</b>\n   📦 ${r.title || r.item_id}\n   🔢 ${r.unidades} un. · ${Rfmt(r.receita)}\n\n`;
      });

      await tgNotify('tg_topvendas', msg.trim());
      console.log(`[top-vendas] notificado — ${rows.length} item(ns)`);
      return { itens: rows.length, top: rows.map(r => ({ loja: r.loja, item: r.title, unidades: Number(r.unidades), receita: Number(r.receita) })) };
    });
  } finally {
    isSyncingTopVendas = false;
    scheduleEvery(4, syncTopVendas, 'top-vendas');
  }
}

// Recupera pedidos que foram marcados como 'skipped' por cooldown de 429
// Roda a cada hora para não perder vendas durante picos de rate limit
let isReprocessing = false;
async function reprocessSkipped() {
  if (isReprocessing) return;
  isReprocessing = true;
  try {
    // Busca orders_v2 skipped nas últimas 4h, agrupados por resource+store mais recente
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (resource, store_id)
        id, resource, store_id, topic
      FROM webhook_logs
      WHERE status = 'skipped'
        AND topic = 'orders_v2'
        AND received_at > now() - interval '4 hours'
      ORDER BY resource, store_id, received_at DESC
    `);

    if (rows.length === 0) return;
    console.log(`[reprocess] ${rows.length} pedidos skipped para reprocessar`);

    for (const row of rows) {
      // Verifica se o pedido já foi processado por outro webhook mais recente
      const orderId = row.resource.split('/').pop();
      const { rows: existing } = await pool.query(
        `SELECT ml_id FROM orders WHERE ml_id=$1`, [orderId]
      );
      if (existing.length > 0) {
        await pool.query(`UPDATE webhook_logs SET status='processed', processed_at=now() WHERE id=$1`, [row.id]);
        continue;
      }

      // Cooldown ainda ativo?
      const cooldownKey = `orders_v2:${row.store_id}`;
      if (apiCooldown.has(cooldownKey) && Date.now() < apiCooldown.get(cooldownKey)) continue;

      try {
        await handleOrder({ resource: row.resource, storeId: row.store_id, silent: true });
        await pool.query(`UPDATE webhook_logs SET status='processed', processed_at=now() WHERE id=$1`, [row.id]);
        console.log(`[reprocess] ✅ recuperado: ${row.resource}`);
      } catch (e) {
        console.warn(`[reprocess] ⚠ erro ao recuperar ${row.resource}:`, e.message);
        if (e.message?.includes('429')) break; // stop se ainda em rate limit
      }
      await new Promise(r => setTimeout(r, 3000)); // 3s entre recuperações
    }
  } catch (e) {
    console.error('[reprocess] erro:', e.message);
  } finally {
    isReprocessing = false;
  }
}

// Roda reprocessSkipped a cada 30 minutos
setInterval(() => reprocessSkipped().catch(e => console.error('[reprocess] interval erro:', e.message)), 30 * 60 * 1000);
// Primeira execução após 5 minutos do start
setTimeout(() => reprocessSkipped().catch(e => console.error('[reprocess] initial erro:', e.message)), 5 * 60 * 1000);

// Conciliação Bancária (Fase 1) — cobranças oficiais de tarifa (grupos ML e MP),
// só do período em aberto atual, nunca varre período fechado/histórico (pedido
// explícito do usuário de só sincronizar dado novo a partir de agora). Sempre
// relê a 1ª página do período aberto e usa ON CONFLICT (detail_id) DO NOTHING —
// idempotente, então não depende de nenhuma premissa sobre ordenação/semântica
// do cursor last_id da API (não confirmada em nenhum teste ao vivo até agora).
// Ver .claude/decisions.md e server/test-billing.js (script exploratório que
// descobriu o endpoint/parâmetros).
async function syncBillingCharges() {
  const { rows: stores } = await pool.query(
    `SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL`
  );
  for (const store of stores) {
    for (const group of ['ML', 'MP']) {
      try {
        const periods = await ml.getBillingPeriods(group, store.id, 1);
        const open = periods?.results?.find(p => p.period_status === 'OPEN') || periods?.results?.[0];
        if (!open) continue;

        const details = await ml.getBillingDetails(open.key, group, store.id, { limit: 150 });
        let inserted = 0;
        for (const row of details?.results || []) {
          const ci = row.charge_info || {};
          if (!ci.detail_id) continue;
          const { rowCount } = await pool.query(
            `INSERT INTO ml_billing_charges (detail_id, store_id, billing_group, period_key, transaction_detail, detail_type, detail_sub_type, detail_amount, creation_date_time, raw_data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (detail_id) DO NOTHING`,
            [ci.detail_id, store.id, group, open.key, ci.transaction_detail || null, ci.detail_type || null, ci.detail_sub_type || null, ci.detail_amount || null, ci.creation_date_time || null, JSON.stringify(row)]
          );
          if (rowCount) inserted++;
        }
        if (inserted) console.log(`[billing] ${store.nickname} group=${group} período=${open.key}: ${inserted} cobrança(s) nova(s)`);
      } catch (e) {
        console.warn(`[billing] ${store.nickname} group=${group}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000)); // respiro entre chamadas
    }
  }
}
// Billing é o endpoint que mais devolve 429 e as cobranças mudam pouco ao longo
// do dia — rodar a cada 30 min era desperdício e pressão desnecessária no
// orçamento por-app do ML. Frequência reduzida (default 3h, ajustável por env).
const BILLING_INTERVAL_MS = Number(process.env.ML_BILLING_INTERVAL_MIN || 180) * 60 * 1000;
setInterval(() => syncBillingCharges().catch(e => console.error('[billing] interval erro:', e.message)), BILLING_INTERVAL_MS);
setTimeout(() => syncBillingCharges().catch(e => console.error('[billing] initial erro:', e.message)), 6 * 60 * 1000);

// Conciliação fase 2: baixa/parseia os Relatórios de Liberação do Mercado Pago
// (mp_account_movements). 1x/dia, auto-reagendado. Ver mpReports.js.
async function runMpReports() {
  try { await recordSync('mp-reports', '40 5 * * *', () => syncMpAccountReports()); }
  catch (e) { console.error('[mp-reports] erro:', e.message); }
  finally { scheduleAt(5, 40, runMpReports, 'mp-reports'); }
}

// Monitoramento de concorrentes (Análise de Produtos): snapshot diário de cada
// MLB coletado. Ver server/src/analise/monitor.js e .claude/analise-produtos.md.
const analiseMonitor = require('./analise/monitor');
async function syncMonitorAnalise() {
  try { await recordSync('sync-monitor-analise', '45 5 * * *', () => analiseMonitor.snapshotAll()); }
  catch (e) { console.error('[sync-monitor-analise] erro:', e.message); }
  finally { scheduleAt(5, 45, syncMonitorAnalise, 'sync-monitor-analise'); }
}

scheduleAt(1,  0,  syncScores,   'sync-scores');
scheduleAt(1, 30, syncParentItems, 'sync-parent-items');
scheduleAt(5, 45,  syncMonitorAnalise, 'sync-monitor-analise');
scheduleAt(2,  0,  syncVisitas,  'sync-visitas');
scheduleAt(3,  0,  syncVendas,   'sync-vendas');
scheduleAt(3, 30,  cleanupPackingVideos, 'cleanup-packing-videos');
scheduleAt(3, 45,  cleanupWebhookLogs, 'cleanup-webhook-logs');
scheduleAt(2, 30,  backupDatabase, 'backup-database');
scheduleAt(4, 15,  syncMetricas, 'sync-metricas');
scheduleAt(4, 30,  syncSeoScore, 'sync-seo-score');
scheduleAt(4, 50,  syncCatalogCompetition, 'sync-catalog-competition');
scheduleAt(5,  0,  syncPrecos,   'sync-precos');
scheduleAt(5, 15,  syncPaymentReleases, 'sync-payment-releases');
scheduleEveryMinutes(10, financeReconciliationJob, 'finance-reconciliation');
scheduleAt(5, 25,  checkConciliacaoDivergencias, 'conciliacao-divergencias');
scheduleAt(5, 40,  runMpReports, 'mp-reports');
scheduleEvery(4,   syncShippingStatus, 'sync-shipping-status');
scheduleAt(6,  0,  resumoDiario, 'resumo-diario');
scheduleAt(6,  5,  fechamentoDiario, 'fechamento-diario');
scheduleAt(6, 10,  emailDailyReports, 'email-diario');
scheduleAt(6, 20,  checkOutlierEstatistico, 'outlier-check');
scheduleAt(6, 30,  checkTaxaDevolucaoAlta, 'taxa-devolucao');
scheduleAt(8, 15,  checkTarefasAtrasadas, 'tarefas-atrasadas');
scheduleAt(7, 30,  checkRupturaEstoque, 'ruptura-estoque');
scheduleAt(7,  0,  () => syncClaimsStatus(false), 'sync-claims-status'); // reconsulta devoluções → alerta quando encerra
scheduleWeekly(1, 7, 0, emailRelatorioSemanal, 'email-semanal');
scheduleEvery(4,   syncTopVendas, 'top-vendas');
scheduleEvery(6,   syncRanking, 'sync-ranking'); // fase 1 (rankeando) — qualquer mudança, a cada 6h
scheduleAt(5, 15,  syncRankingRanqueado, 'sync-ranking-ranqueado'); // fase 2 (ranqueado) — só regressão, 1x/dia
scheduleEvery(1,   syncRankingAlerts, 'sync-ranking-alerts'); // alertas de revisão de ADS — a cada 1h

// Notion Tarefas — 2ª feira 08:00 (usa setTimeout próprio, não scheduleAt)
setTimeout(() => syncNotionTarefas().catch(e => console.error('[notion] boot erro:', e.message)), (() => {
  const now = new Date();
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(8, 0, 0, 0);
  const ms = next - now;
  console.log(`[notion] agendado para ${next.toLocaleString('pt-BR')} (${Math.round(ms/3600000)}h)`);
  return ms;
})());

tokenRefreshLoop(); // roda imediatamente no start
setInterval(tokenRefreshLoop, 30 * 60 * 1000);

// Saúde do Sistema — heartbeat 'worker' + checagem de alertas (fila, dead-letter,
// restart-loop, webhooks travados). Ver health.js e .claude/workers.md.
const health = require('./health');
health.startHeartbeat('worker');
setTimeout(() => health.checkAndAlert(), 90 * 1000);           // pega crash-loop cedo
setInterval(() => health.checkAndAlert(), 5 * 60 * 1000);      // depois a cada 5 min

// Ao iniciar o worker, roda syncVendas após 2 min SOMENTE fora do horário de pico (22h–08h)
setTimeout(() => {
  const h = new Date().getHours();
  if (h >= 22 || h < 8) {
    console.log('[worker] sync inicial automático (fora do pico)');
    syncVendas().catch(e => console.error('[worker] sync-vendas inicial erro:', e.message));
  } else {
    console.log(`[worker] sync inicial ignorado — horário de pico (${h}h). Aguardando 03:00.`);
  }
}, 2 * 60 * 1000);

// Listener para comandos manuais via Redis pub/sub (ex: trigger do painel)
const cmdSub = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000 });
cmdSub.subscribe('worker:cmd');
cmdSub.on('message', (channel, msg) => {
  try {
    // known-bugs #9: o botão "▶ Executar" de schedule.html manda o nome kebab
    // de schedule_jobs.name (ex.: 'sync-vendas'), mas o encadeamento abaixo só
    // reconhece camelCase. Traduz pros nomes que os handlers já tratam (que já
    // chamam a função INTERNA, não a que se reagenda). Jobs que se auto-reagendam
    // e não têm handler interno (resumo-diario, fechamento-diario) ficam de fora
    // de propósito — dispará-los aqui duplicaria o timer.
    const CMD_ALIASES = {
      'sync-vendas': 'syncVendas', 'sync-metricas': 'syncMetricas', 'sync-visitas': 'syncVisitas',
      'sync-precos': 'syncPrecos', 'sync-scores': 'syncScores', 'sync-parent-items': 'syncParentItems',
      'top-vendas': 'syncTopVendas', 'email-diario': 'emailDailyReports', 'email-semanal': 'emailRelatorioSemanal',
      'outlier-check': 'checkOutlierEstatistico', 'taxa-devolucao': 'checkTaxaDevolucaoAlta',
      'tarefas-atrasadas': 'checkTarefasAtrasadas',
      // já dual-registrados no chain (kebab aceito direto): sync-seo-score,
      // sync-catalog-competition, sync-payment-releases, sync-shipping-status,
      // sync-claims-status, mp-reports, conciliacao-divergencias.
    };
    const parsed = JSON.parse(msg);
    const cmd = CMD_ALIASES[parsed.cmd] || parsed.cmd;
    if (cmd === 'dailySync' || cmd === 'syncVendas') {
      console.log('[worker] syncVendas disparado manualmente');
      syncVendas().catch(e => console.error('[worker] syncVendas manual erro:', e.message));
    }
    if (cmd === 'syncMetricas') {
      console.log('[worker] syncMetricas disparado manualmente');
      syncMetricas().catch(e => console.error('[worker] syncMetricas erro:', e.message));
    }
    if (cmd === 'syncReturns') {
      console.log('[worker] syncReturns (retroativo) disparado manualmente');
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
    if (cmd === 'syncPrecos') {
      console.log('[worker] syncPrecos disparado manualmente');
      syncPrecos().catch(e => console.error('[worker] syncPrecos erro:', e.message));
    }
    if (cmd === 'syncScores') {
      console.log('[worker] syncScores disparado manualmente');
      syncScores().catch(e => console.error('[worker] syncScores erro:', e.message));
    }
    if (cmd === 'sync-seo-score' || cmd === 'syncSeoScore') {
      console.log('[worker] syncSeoScore disparado manualmente');
      syncSeoScore().catch(e => console.error('[worker] syncSeoScore erro:', e.message));
    }
    if (cmd === 'sync-catalog-competition' || cmd === 'syncCatalogCompetition') {
      console.log('[worker] syncCatalogCompetition disparado manualmente');
      syncCatalogCompetition().catch(e => console.error('[worker] syncCatalogCompetition erro:', e.message));
    }
    if (cmd === 'syncNotionTarefas') {
      console.log('[worker] syncNotionTarefas disparado manualmente');
      syncNotionTarefas().catch(e => console.error('[worker] syncNotionTarefas erro:', e.message));
    }
    if (cmd === 'sync-ranking-alerts' || cmd === 'syncRankingAlerts') {
      console.log('[worker] syncRankingAlerts disparado manualmente');
      syncRankingAlerts().catch(e => console.error('[worker] syncRankingAlerts erro:', e.message));
    }
    if (cmd === 'reprocessSkipped') {
      console.log('[worker] reprocessSkipped disparado manualmente');
      reprocessSkipped().catch(e => console.error('[worker] reprocessSkipped erro:', e.message));
    }
    if (cmd === 'syncBillingCharges') {
      console.log('[worker] syncBillingCharges disparado manualmente');
      syncBillingCharges().catch(e => console.error('[worker] syncBillingCharges erro:', e.message));
    }
    if (cmd === 'sync-payment-releases' || cmd === 'syncPaymentReleases') {
      console.log('[worker] syncPaymentReleases disparado manualmente');
      syncPaymentReleases().catch(e => console.error('[worker] syncPaymentReleases erro:', e.message));
    }
    if (cmd === 'finance-reconciliation' || cmd === 'financeReconciliationJob') {
      console.log('[worker] financeReconciliationJob disparado manualmente');
      financeReconciliationJob().catch(e => console.error('[worker] financeReconciliationJob erro:', e.message));
    }
    if (cmd === 'conciliacao-divergencias' || cmd === 'checkConciliacaoDivergencias') {
      console.log('[worker] checkConciliacaoDivergencias disparado manualmente');
      checkConciliacaoDivergencias().catch(e => console.error('[worker] checkConciliacaoDivergencias erro:', e.message));
    }
    if (cmd === 'sync-shipping-status' || cmd === 'syncShippingStatus') {
      console.log('[worker] syncShippingStatus disparado manualmente');
      syncShippingStatus().catch(e => console.error('[worker] syncShippingStatus erro:', e.message));
    }
    if (cmd === 'sync-claims-status' || cmd === 'syncClaimsStatus') {
      console.log('[worker] syncClaimsStatus disparado manualmente');
      syncClaimsStatus(true).catch(e => console.error('[worker] syncClaimsStatus erro:', e.message));
    }
    if (cmd === 'mp-reports' || cmd === 'syncMpAccountReports') {
      console.log('[worker] syncMpAccountReports disparado manualmente');
      syncMpAccountReports().catch(e => console.error('[worker] syncMpAccountReports erro:', e.message));
    }
    if (cmd === 'mp-reports-backfill' || cmd === 'backfillMpReports') {
      console.log('[worker] backfillMpReports (6 meses) disparado manualmente');
      backfillMpReports(6).catch(e => console.error('[worker] backfillMpReports erro:', e.message));
    }
    if (cmd === 'syncTopVendas') {
      console.log('[worker] syncTopVendas disparado manualmente');
      syncTopVendas().catch(e => console.error('[worker] syncTopVendas erro:', e.message));
    }
    if (cmd === 'emailDailyReports') {
      console.log('[worker] emailDailyReports disparado manualmente');
      emailDailyReports().catch(e => console.error('[worker] emailDailyReports erro:', e.message));
    }
    if (cmd === 'emailRelatorioSemanal') {
      console.log('[worker] emailRelatorioSemanal disparado manualmente');
      emailRelatorioSemanal().catch(e => console.error('[worker] emailRelatorioSemanal erro:', e.message));
    }
    if (cmd === 'checkOutlierEstatistico') {
      console.log('[worker] checkOutlierEstatistico disparado manualmente');
      checkOutlierEstatistico().catch(e => console.error('[worker] checkOutlierEstatistico erro:', e.message));
    }
    if (cmd === 'checkTaxaDevolucaoAlta') {
      console.log('[worker] checkTaxaDevolucaoAlta disparado manualmente');
      checkTaxaDevolucaoAlta().catch(e => console.error('[worker] checkTaxaDevolucaoAlta erro:', e.message));
    }
    if (cmd === 'checkTarefasAtrasadas') {
      console.log('[worker] checkTarefasAtrasadas disparado manualmente');
      checkTarefasAtrasadas().catch(e => console.error('[worker] checkTarefasAtrasadas erro:', e.message));
    }
  } catch {}
});

// ── Telegram Bot — listener de comandos ──────────────────
// Usa long polling para receber mensagens sem precisar configurar webhook no Telegram.
// Comandos suportados:
//   /refresh         — tenta renovar tokens de todas as lojas expiradas
//   /refresh topmix  — tenta renovar token de uma loja pelo nome (busca parcial)
//   /status          — mostra status dos tokens de todas as lojas
let _tgOffset = 0;
const DASH_URL = process.env.DASH_URL || 'https://multimixvendas.duckdns.org';

async function tgReply(chatId, text, botToken) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[tg-bot] reply error:', e.message);
  }
}

async function handleTgCommand(text, chatId, botToken) {
  const cmd = (text || '').trim().toLowerCase().split(/\s+/);

  if (cmd[0] === '/status') {
    const { rows } = await pool.query(`SELECT id, nickname, token_expires_at, refresh_failures FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') ORDER BY nickname`);
    const lines = rows.map(r => {
      const exp = r.token_expires_at ? new Date(r.token_expires_at) : null;
      const isEpoch = !exp || exp.getFullYear() < 2000;
      const expiresIn = exp ? exp - Date.now() : -1;
      const horas = isEpoch ? 0 : Math.floor(expiresIn / 3600000);
      const status = isEpoch ? '❌ Expirado' : expiresIn > 0 ? `✅ ${horas}h restantes` : '⚠️ Expirou agora';
      const falhas = r.refresh_failures > 0 ? ` (${r.refresh_failures} falhas)` : '';
      return `🏪 <b>${r.nickname}</b>\n${status}${falhas}`;
    });
    await tgReply(chatId, `<b>Status dos tokens:</b>\n\n${lines.join('\n\n')}`, botToken);
    return;
  }

  if (cmd[0] === '/refresh') {
    const filtro = cmd[1] || '';
    const { rows } = await pool.query(`SELECT id, nickname, token_expires_at FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') ORDER BY nickname`);
    const lojas = filtro
      ? rows.filter(r => r.nickname.toLowerCase().includes(filtro))
      : rows.filter(r => {
          const exp = r.token_expires_at ? new Date(r.token_expires_at) : null;
          return !exp || exp.getFullYear() < 2000 || (exp - Date.now()) < 4 * 60 * 60 * 1000;
        });

    if (!lojas.length) {
      await tgReply(chatId, filtro ? `❓ Nenhuma loja encontrada com "<b>${filtro}</b>"` : '✅ Todos os tokens estão válidos — nenhum refresh necessário.', botToken);
      return;
    }

    await tgReply(chatId, `🔄 Tentando renovar token de ${lojas.length} loja(s)...`, botToken);

    for (const loja of lojas) {
      try {
        await refreshToken(loja.id);
        expiredStores.delete(loja.id);
        await tgReply(chatId, `✅ <b>${loja.nickname}</b> — token renovado com sucesso!`, botToken);
      } catch (e) {
        const link = `${DASH_URL}/auth/login?store_id=${loja.id}`;
        await tgReply(chatId,
          `❌ <b>${loja.nickname}</b> — refresh falhou\n` +
          `Erro: <code>${e.message.slice(0, 150)}</code>\n\n` +
          `Para reconectar, acesse:\n🔗 <a href="${link}">${link}</a>`,
          botToken
        );
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    return;
  }

  if (cmd[0] === '/sync') {
    const tipo = cmd[1] || 'vendas';
    if (tipo === 'vendas') {
      await tgReply(chatId, '🔄 Iniciando sync de <b>vendas</b> (últimas 72h)...', botToken);
      syncVendas().catch(e => console.error('[tg-bot] syncVendas erro:', e.message));
    } else if (tipo === 'metricas') {
      await tgReply(chatId, '📊 Iniciando sync de <b>métricas</b> (reputação + devoluções)...', botToken);
      syncMetricas().catch(e => console.error('[tg-bot] syncMetricas erro:', e.message));
    } else if (tipo === 'visitas') {
      await tgReply(chatId, '👁 Iniciando sync de <b>visitas</b>...', botToken);
      syncVisitas().catch(e => console.error('[tg-bot] syncVisitas erro:', e.message));
    } else if (tipo === 'devolucoes') {
      await tgReply(chatId, '↩️ Iniciando busca retroativa de <b>devoluções</b>...', botToken);
      syncReturns().catch(e => console.error('[tg-bot] syncReturns erro:', e.message));
    } else if (tipo === 'topvendas') {
      await tgReply(chatId, '📈 Verificando <b>top vendas</b> (últimas 4h)...', botToken);
      syncTopVendas().catch(e => console.error('[tg-bot] syncTopVendas erro:', e.message));
    } else if (tipo === 'email-diario') {
      await tgReply(chatId, '📧 Gerando <b>relatórios diários</b> por e-mail...', botToken);
      emailDailyReports().catch(e => console.error('[tg-bot] emailDailyReports erro:', e.message));
    } else if (tipo === 'email-semanal') {
      await tgReply(chatId, '📧 Gerando <b>relatório semanal</b> por e-mail...', botToken);
      emailRelatorioSemanal().catch(e => console.error('[tg-bot] emailRelatorioSemanal erro:', e.message));
    } else if (tipo === 'outlier') {
      await tgReply(chatId, '📊 Verificando <b>outliers estatísticos</b> (dia anterior vs. média histórica)...', botToken);
      checkOutlierEstatistico().catch(e => console.error('[tg-bot] checkOutlierEstatistico erro:', e.message));
    } else {
      await tgReply(chatId, '❓ Tipos disponíveis: <code>vendas</code>, <code>metricas</code>, <code>visitas</code>, <code>devolucoes</code>, <code>topvendas</code>, <code>email-diario</code>, <code>email-semanal</code>, <code>outlier</code>', botToken);
    }
    return;
  }

  if (cmd[0] === '/help' || cmd[0] === '/start') {
    await tgReply(chatId,
      `<b>Comandos disponíveis:</b>\n\n` +
      `/status — status dos tokens de todas as lojas\n` +
      `/refresh — renovar tokens expirados\n` +
      `/refresh [nome] — renovar token de uma loja específica\n` +
      `/sync vendas — forçar reconciliação de pedidos (72h)\n` +
      `/sync metricas — forçar coleta de reputação + devoluções\n` +
      `/sync visitas — forçar coleta de visitas por anúncio\n` +
      `/sync devolucoes — busca retroativa completa de devoluções\n` +
      `/sync topvendas — forçar checagem de top vendas (últimas 4h)\n` +
      `/sync email-diario — forçar envio dos e-mails diários (resumo + top vendas)\n` +
      `/sync email-semanal — forçar envio do relatório semanal por e-mail\n` +
      `/sync outlier — forçar checagem de outlier estatístico (dia anterior vs. média histórica)\n\n` +
      `Exemplos: <code>/refresh topmix</code>  <code>/sync vendas</code>`,
      botToken
    );
    return;
  }
}

async function tgBotLoop() {
  const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='telegram_bot_token' LIMIT 1`);
  const botToken = rows[0]?.value || env.tg?.botToken;
  if (!botToken) return; // bot não configurado

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${_tgOffset}&timeout=25&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(30000) }
    );
    if (!r.ok) { await new Promise(x => setTimeout(x, 10000)); return; }
    const data = await r.json();
    for (const update of (data.result || [])) {
      _tgOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text?.startsWith('/')) continue;
      console.log(`[tg-bot] comando: ${msg.text} de chat_id=${msg.chat.id}`);
      handleTgCommand(msg.text, msg.chat.id, botToken).catch(e => console.error('[tg-bot] erro:', e.message));
    }
  } catch (e) {
    if (e.name !== 'TimeoutError') console.error('[tg-bot] polling error:', e.message);
  }
  setTimeout(tgBotLoop, 1000);
}

tgBotLoop();

console.log('[worker] listening for ml-webhooks jobs...');

// Marketplace Engine — consumo de eventos de outros marketplaces (Amazon hoje),
// totalmente à parte do dispatch table ML acima. Ver .claude/decisions.md.
require('./marketplaceEventWorker').startMarketplaceEventWorkers();
