// Consome eventos padronizados publicados por EventSources de marketplace
// (hoje: AmazonPollingEventSource e ShopeePollingEventSource, uma instância
// por conta cadastrada em `stores`) em filas BullMQ próprias por marketplace,
// totalmente desacopladas do dispatch table `handlers`/`processJob` do
// Mercado Livre em worker.js — este arquivo não altera nenhuma linha do
// pipeline ML existente.
// Ver .claude/decisions.md ("Marketplace Engine — EventSource").
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const pool = require('./db/pool');
const redis = require('./db/redis');
const { publish } = require('./ws/hub');
const { tgNotify } = require('./notify');
const { Scheduler } = require('./marketplaces/Scheduler');
const { AmazonPollingEventSource } = require('./marketplaces/amazon/AmazonPollingEventSource');
const { ShopeePollingEventSource } = require('./marketplaces/shopee/ShopeePollingEventSource');
const { MockClient, MockEventSource } = require('./marketplaces/mock/mockProvider');

const AMAZON_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min — ajustável sem tocar no restante do pipeline
const SHOPEE_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min — mesmo intervalo da Amazon na fase 1 (polling)
const MOCK_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2min — mais rápido para dar feedback visível em dev
const SHOPEE_CHAT_INTERVAL_MS = 10 * 60 * 1000; // 10min — poll de mensagens não lidas do chat Shopee
const SHOPEE_CATALOG_INTERVAL_MS = Number(process.env.SHOPEE_CATALOG_INTERVAL_MS || 30 * 60 * 1000); // 30min — sync do catálogo (Product API)
const SHOPEE_PROMO_INTERVAL_MS = Number(process.env.SHOPEE_PROMO_INTERVAL_MS || 60 * 60 * 1000); // 1h — sync de promoções + alerta de vencimento
const SHOPEE_PROMO_ALERT_HOURS = Number(process.env.SHOPEE_PROMO_ALERT_HOURS || 24); // alerta quando a promoção vence em menos de X horas
const SHOPEE_RETURNS_INTERVAL_MS = Number(process.env.SHOPEE_RETURNS_INTERVAL_MS || 60 * 60 * 1000); // 1h — sync de devoluções/reembolsos
const SHOPEE_RETURNS_LOOKBACK_DAYS = Number(process.env.SHOPEE_RETURNS_LOOKBACK_DAYS || 180); // histórico de devoluções (varrido em janelas de 15d)

// AMAZON_ENV=mock troca o cliente/EventSource real por um que fabrica pedidos
// de teste variados, sem depender do sandbox estático da Amazon (que só
// devolve um pedido fixo). Trocar de volta para a Amazon real é só mudar
// AMAZON_ENV — nada mais no pipeline muda (ver .claude/amazon.md).
const isMock = env.amazon?.env === 'mock';

// Client Amazon (ou mock) por conta — chave é `stores.id`, não o código do
// marketplace, porque pode haver várias contas Amazon simultâneas. Populado
// em startMarketplaceEventWorkers() a partir das linhas de `stores` com
// marketplace_id=AMAZON.
const clients = new Map();

// Mesma ideia, mapa separado para contas Shopee (marketplace_id=SHOPEE).
const shopeeClients = new Map();

// Vocabulário compartilhado de `orders.status` — ajuste fino de quais status
// da Amazon contam como "pago" fica para quando pedidos reais de sandbox/
// produção começarem a chegar (hoje sandbox só devolve dados de teste estáticos).
function mapAmazonStatus(orderStatus) {
  switch (orderStatus) {
    case 'Shipped':
    case 'PartiallyShipped':
    case 'Unshipped':
      return 'paid'; // Amazon só libera o pedido para o seller depois do pagamento capturado
    case 'Canceled':
      return 'cancelled';
    case 'Pending':
      return 'pending';
    default:
      return (orderStatus || '').toLowerCase();
  }
}

async function handleOrderEvent(evt) {
  const client = clients.get(evt.storeId);
  if (!client) { console.warn(`[marketplace-worker] sem client para storeId=${evt.storeId}`); return; }

  const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = $1`, [evt.marketplace]);
  const marketplaceId = mp[0]?.id;
  if (!marketplaceId) { console.warn(`[marketplace-worker] marketplace ${evt.marketplace} não cadastrado`); return; }

  const orderResp = await client.getOrder(evt.resourceId);
  const o = orderResp?.payload || orderResp;
  if (!o?.AmazonOrderId) { console.warn(`[marketplace-worker] resposta sem AmazonOrderId para ${evt.resourceId}`); return; }

  const status = mapAmazonStatus(o.OrderStatus);
  const totalAmount = Number(o.OrderTotal?.Amount || 0);

  const { rows: prevRows } = await pool.query(`SELECT status FROM orders WHERE ml_id = $1`, [o.AmazonOrderId]);
  const previousStatus = prevRows[0]?.status || null;

  await pool.query(
    `INSERT INTO orders (ml_id, marketplace_id, store_id, total_amount, status, date_created, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       marketplace_id = EXCLUDED.marketplace_id,
       total_amount = EXCLUDED.total_amount,
       status = EXCLUDED.status,
       updated_at = now()`,
    [o.AmazonOrderId, marketplaceId, evt.storeId, totalAmount, status, o.PurchaseDate || null]
  );

  await pool.query(
    `INSERT INTO amazon_order_data (order_id, amazon_order_id, seller_id, fulfillment_channel, order_type, raw_data, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (order_id) DO UPDATE SET
       fulfillment_channel = EXCLUDED.fulfillment_channel,
       order_type = EXCLUDED.order_type,
       raw_data = EXCLUDED.raw_data,
       updated_at = now()`,
    [o.AmazonOrderId, o.AmazonOrderId, evt.sellerId || null, o.FulfillmentChannel || null, o.OrderType || null, JSON.stringify(o)]
  );

  await redis.del('kpis:summary');
  await publish('order_updated', { id: o.AmazonOrderId, status, marketplace: 'AMAZON', storeId: evt.storeId });

  if (status === 'paid' && previousStatus !== 'paid') {
    console.log(`[marketplace-worker] ✅ nova venda Amazon (store_id=${evt.storeId}): ${o.AmazonOrderId} | R$ ${totalAmount}`);
  }
}

// Vocabulário compartilhado de `orders.status` para pedidos Shopee — a
// Shopee só libera o pedido para READY_TO_SHIP depois do pagamento
// confirmado, por isso os status "operacionais" (embalar/enviar/concluído)
// já contam como 'paid' (ver .claude/business-rules.md e 04-Orders.md da
// KB fornecida pelo usuário).
// Status em que o pedido já tem etiqueta/rastreio emitido (tracking existe).
// Antes disso (UNPAID/pago sem preparo) o get_tracking_number vem vazio.
const SHOPEE_SHIPPABLE = new Set(['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED']);

function mapShopeeStatus(orderStatus) {
  switch (orderStatus) {
    case 'READY_TO_SHIP':
    case 'PROCESSED':
    case 'SHIPPED':
    case 'COMPLETED':
      return 'paid';
    case 'CANCELLED':
    case 'IN_CANCEL':
      return 'cancelled';
    case 'UNPAID':
      return 'pending';
    default:
      return (orderStatus || '').toLowerCase();
  }
}

async function handleShopeeOrderEvent(evt) {
  const client = shopeeClients.get(evt.storeId);
  if (!client) { console.warn(`[marketplace-worker] sem client Shopee para storeId=${evt.storeId}`); return; }

  const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = $1`, [evt.marketplace]);
  const marketplaceId = mp[0]?.id;
  if (!marketplaceId) { console.warn(`[marketplace-worker] marketplace ${evt.marketplace} não cadastrado`); return; }

  const o = await client.getOrder(evt.resourceId);
  if (!o?.order_sn) { console.warn(`[marketplace-worker] resposta sem order_sn para ${evt.resourceId}`); return; }

  const status = mapShopeeStatus(o.order_status);
  const totalAmount = Number(o.total_amount || 0);

  const { rows: prevRows } = await pool.query(`SELECT status FROM orders WHERE ml_id = $1`, [o.order_sn]);
  const previousStatus = prevRows[0]?.status || null;

  await pool.query(
    `INSERT INTO orders (ml_id, marketplace_id, store_id, total_amount, status, date_created, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (ml_id) DO UPDATE SET
       marketplace_id = EXCLUDED.marketplace_id,
       total_amount = EXCLUDED.total_amount,
       status = EXCLUDED.status,
       updated_at = now()`,
    [o.order_sn, marketplaceId, evt.storeId, totalAmount, status, o.create_time ? new Date(o.create_time * 1000) : null]
  );

  // Busca sob-demanda: rastreio (Embalagem disponível assim que é gerado pela Shopee),
  // financeiro/escrow (líquido+taxas) e status de entrega. Tudo tolerante a falha —
  // nunca quebra o handler; COALESCE no upsert não apaga o que já estava se uma das
  // chamadas vier vazia. Tracking pode estar disponível antes do status READY_TO_SHIP.
  let trackingNumber = null, escrow = null, logisticsStatus = null;
  try { trackingNumber = await client.getTrackingNumber(o.order_sn); }
  catch (e) { console.warn(`[marketplace-worker] tracking Shopee ${o.order_sn}: ${e.message}`); }
  if (SHOPEE_SHIPPABLE.has(o.order_status)) {
    try { escrow = await client.getEscrowDetail(o.order_sn); }
    catch (e) { console.warn(`[marketplace-worker] escrow Shopee ${o.order_sn}: ${e.message}`); }
    try { logisticsStatus = (await client.getTrackingInfo(o.order_sn))?.logistics_status || null; }
    catch (e) { console.warn(`[marketplace-worker] tracking-info Shopee ${o.order_sn}: ${e.message}`); }
  }
  const inc = escrow?.order_income || {};
  const buyerTotal = escrow ? Number(inc.buyer_total_amount ?? 0) : null;
  const commissionFee = escrow ? Number(inc.commission_fee ?? 0) : null;
  const escrowAmount = escrow ? Number(inc.escrow_amount ?? 0) : null;
  const payMethod = escrow ? (inc.buyer_payment_method || null) : null;
  // Taxas líquidas (NET) — valor final descontado após rebates (mudança Shopee
  // dez/2025–fev/2026, ver .claude/shopee.md). NULL quando a API não devolve
  // (pedido/escrow anterior à mudança) → cálculo cai no bruto.
  const num = (v) => (v == null ? null : Number(v));
  const serviceFee = escrow ? num(inc.service_fee) : null;
  const netCommissionFee = escrow ? num(inc.net_commission_fee) : null;
  const netServiceFee = escrow ? num(inc.net_service_fee) : null;
  // seller_product_rebate é um objeto ({amount, *_offset}) — guarda como JSON.
  const sellerRebate = escrow && inc.seller_product_rebate != null ? JSON.stringify(inc.seller_product_rebate) : null;

  await pool.query(
    `INSERT INTO shopee_order_data (order_id, order_sn, shop_id, buyer_username, order_status, raw_data,
        tracking_number, buyer_total, commission_fee, escrow_amount, buyer_payment_method, escrow_raw, logistics_status,
        service_fee, net_commission_fee, net_service_fee, seller_product_rebate, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     ON CONFLICT (order_id) DO UPDATE SET
       shop_id = EXCLUDED.shop_id,
       buyer_username = EXCLUDED.buyer_username,
       order_status = EXCLUDED.order_status,
       raw_data = EXCLUDED.raw_data,
       tracking_number = COALESCE(EXCLUDED.tracking_number, shopee_order_data.tracking_number),
       buyer_total = COALESCE(EXCLUDED.buyer_total, shopee_order_data.buyer_total),
       commission_fee = COALESCE(EXCLUDED.commission_fee, shopee_order_data.commission_fee),
       escrow_amount = COALESCE(EXCLUDED.escrow_amount, shopee_order_data.escrow_amount),
       buyer_payment_method = COALESCE(EXCLUDED.buyer_payment_method, shopee_order_data.buyer_payment_method),
       escrow_raw = COALESCE(EXCLUDED.escrow_raw, shopee_order_data.escrow_raw),
       logistics_status = COALESCE(EXCLUDED.logistics_status, shopee_order_data.logistics_status),
       service_fee = COALESCE(EXCLUDED.service_fee, shopee_order_data.service_fee),
       net_commission_fee = COALESCE(EXCLUDED.net_commission_fee, shopee_order_data.net_commission_fee),
       net_service_fee = COALESCE(EXCLUDED.net_service_fee, shopee_order_data.net_service_fee),
       seller_product_rebate = COALESCE(EXCLUDED.seller_product_rebate, shopee_order_data.seller_product_rebate),
       updated_at = now()`,
    [o.order_sn, o.order_sn, client.cfg?.shopId || null, o.buyer_username || null, o.order_status || null, JSON.stringify(o),
     trackingNumber, buyerTotal, commissionFee, escrowAmount, payMethod, escrow ? JSON.stringify(escrow) : null, logisticsStatus,
     serviceFee, netCommissionFee, netServiceFee, sellerRebate]
  );

  await redis.del('kpis:summary');
  await publish('order_updated', { id: o.order_sn, status, marketplace: 'SHOPEE', storeId: evt.storeId });

  if (status === 'paid' && previousStatus !== 'paid') {
    console.log(`[marketplace-worker] ✅ nova venda Shopee (store_id=${evt.storeId}): ${o.order_sn} | R$ ${totalAmount}`);
    // Guard anti-pedido-antigo (mesmo racional do ML em worker.js): só notifica
    // no Telegram se a venda tem < 24h. Sem isso, o polling descobrindo um
    // pedido antigo (previousStatus nulo → 'paid') spammaria o Telegram — foi
    // exatamente o bug que o ML já tinha. create_time vem em segundos (epoch).
    const saleMs = o.create_time ? Number(o.create_time) * 1000 : 0;
    const isRecentEnough = saleMs && (Date.now() - saleMs < 24 * 60 * 60 * 1000);
    if (!isRecentEnough) {
      console.log(`[marketplace-worker] venda Shopee ${o.order_sn} tem mais de 24h — não notifica no Telegram (anti-pedido-antigo)`);
      return;
    }
    // Notifica no Telegram no mesmo tópico das vendas ML (tg_vendas) — respeita
    // o mesmo on/off, silêncio e throttle já configurados pelo usuário.
    try {
      const { rows: sn } = await pool.query(`SELECT nickname FROM stores WHERE id = $1`, [evt.storeId]);
      const loja = sn[0]?.nickname || `loja ${evt.storeId}`;
      const items = Array.isArray(o.item_list) ? o.item_list : [];
      const titulo = items[0]?.item_name || o.order_sn;
      const qtdItens = items.reduce((s, it) => s + (Number(it.model_quantity_purchased) || 0), 0) || items.length;
      const val = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalAmount);
      await tgNotify('tg_vendas', `🛒 <b>Nova venda!</b>\n🛍️ <b>Shopee</b>\n🏪 ${loja}\n📦 ${titulo}${qtdItens > 1 ? ` (${qtdItens} itens)` : ''}\n💰 ${val}\n🔖 Pedido: ${o.order_sn}`);
    } catch (e) {
      console.error('[marketplace-worker] tgNotify Shopee erro:', e.message);
    }
  }
}

async function startMarketplaceEventWorkers() {
  const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false });

  const wAmazon = new Worker('marketplace-events-amazon', (job) => handleOrderEvent(job.data), {
    connection,
    concurrency: 2,
  });
  wAmazon.on('failed', (job, err) => console.error('[marketplace-worker] failed', job?.id, err.message));
  wAmazon.on('error', (err) => console.error('[marketplace-worker] error:', err.message));
  console.log('[marketplace-worker] started queue marketplace-events-amazon');

  const wShopee = new Worker('marketplace-events-shopee', (job) => handleShopeeOrderEvent(job.data), {
    connection,
    concurrency: 2,
  });
  wShopee.on('failed', (job, err) => console.error('[marketplace-worker] failed', job?.id, err.message));
  wShopee.on('error', (err) => console.error('[marketplace-worker] error:', err.message));
  console.log('[marketplace-worker] started queue marketplace-events-shopee');

  const scheduler = new Scheduler();

  // Uma EventSource por conta Amazon cadastrada — suporta múltiplas contas
  // (cada linha de `stores` com marketplace_id=AMAZON é uma conta), não só a
  // store sentinela original. Ver .claude/decisions.md.
  const { rows: amazonStores } = await pool.query(
    `SELECT id, nickname, refresh_token, amazon_marketplace_id, amazon_region
     FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'AMAZON')`
  );
  if (!amazonStores.length) {
    console.warn('[marketplace-worker] nenhuma conta Amazon cadastrada em `stores` — nada para sincronizar');
  }
  const mockClient = isMock ? new MockClient() : null; // stateless o bastante pra ser compartilhado entre contas
  for (const store of amazonStores) {
    const source = isMock ? new MockEventSource(store) : new AmazonPollingEventSource(store);
    clients.set(store.id, isMock ? mockClient : source.client);
    scheduler.register(source, { intervalMs: isMock ? MOCK_POLL_INTERVAL_MS : AMAZON_POLL_INTERVAL_MS });
    console.log(`[marketplace-worker] conta Amazon registrada: ${store.nickname} (store_id=${store.id})`);
  }

  // Mesma ideia para contas Shopee (marketplace_id=SHOPEE) — fase 1 usa
  // polling (ShopeePollingEventSource), mesmo padrão da Amazon. Ver .claude/shopee.md.
  const { rows: shopeeStores } = await pool.query(
    `SELECT id, nickname, shopee_shop_id, access_token, refresh_token, token_expires_at
     FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'SHOPEE')`
  );
  if (!shopeeStores.length) {
    console.warn('[marketplace-worker] nenhuma conta Shopee cadastrada em `stores` — nada para sincronizar (autorize uma loja em /auth/shopee/login)');
  }
  for (const store of shopeeStores) {
    const source = new ShopeePollingEventSource(store);
    shopeeClients.set(store.id, source.client);
    scheduler.register(source, { intervalMs: SHOPEE_POLL_INTERVAL_MS });
    console.log(`[marketplace-worker] conta Shopee registrada: ${store.nickname} (store_id=${store.id})`);
  }

  scheduler.startAll().catch((err) => console.error('[marketplace-worker] scheduler startAll falhou:', err.message));

  // Chat Shopee — poll de conversas não lidas a cada 10 min, notifica no Telegram
  // as mensagens novas (dedup + guard de 24h). Isolado do pipeline ML.
  if (shopeeStores.length) {
    syncShopeeChat().catch((e) => console.warn('[marketplace-worker] chat Shopee 1º run:', e.message));
    setInterval(() => syncShopeeChat().catch((e) => console.warn('[marketplace-worker] chat Shopee:', e.message)), SHOPEE_CHAT_INTERVAL_MS);

    // Catálogo Shopee (Product API) — sincroniza itens/preço/estoque/variações
    // pra tabela items + shopee_item_data. Fundação de anúncios/precificador/
    // estoque em massa/SEO/tarefas/promoções. Isolado do pipeline ML.
    syncShopeeCatalog().catch((e) => console.warn('[marketplace-worker] catálogo Shopee 1º run:', e.message));
    setInterval(() => syncShopeeCatalog().catch((e) => console.warn('[marketplace-worker] catálogo Shopee:', e.message)), SHOPEE_CATALOG_INTERVAL_MS);

    // Promoções Shopee (descontos + vouchers) — sincroniza prazos e alerta no
    // Telegram quando uma promoção está perto de vencer. Isolado do pipeline ML.
    syncShopeePromos().catch((e) => console.warn('[marketplace-worker] promoções Shopee 1º run:', e.message));
    setInterval(() => syncShopeePromos().catch((e) => console.warn('[marketplace-worker] promoções Shopee:', e.message)), SHOPEE_PROMO_INTERVAL_MS);

    // Devoluções/reembolsos Shopee (Returns API) — sync + alerta Telegram de nova.
    syncShopeeReturns().catch((e) => console.warn('[marketplace-worker] devoluções Shopee 1º run:', e.message));
    setInterval(() => syncShopeeReturns().catch((e) => console.warn('[marketplace-worker] devoluções Shopee:', e.message)), SHOPEE_RETURNS_INTERVAL_MS);
  }
}

// Poll das conversas de chat Shopee não lidas → grava em shopee_chat e notifica
// no Telegram (tópico tg_mensagens, mesmo das mensagens ML). Dedup por
// notified_message_id + guard de 24h (não spammar conversa antiga no 1º run —
// mesmo racional do anti-pedido-antigo das vendas).
async function syncShopeeChat() {
  for (const [storeId, client] of shopeeClients) {
    let convs;
    try { convs = await client.getConversationList('unread', 25); }
    catch (e) { console.warn(`[marketplace-worker] chat Shopee store ${storeId}: ${e.message}`); continue; }
    for (const c of convs || []) {
      if (!c.conversation_id) continue;
      const unread = Number(c.unread_count || 0);
      const latestId = String(c.latest_message_id || '');
      const buyer = c.to_name || String(c.to_id || '');
      const lastText = c.latest_message_content?.text || `(${c.latest_message_type || 'mensagem'})`;
      const toId = c.to_id != null ? String(c.to_id) : null; // user_id do comprador (pra responder via send_message)
      const { rows } = await pool.query(
        `INSERT INTO shopee_chat (conversation_id, store_id, buyer_name, unread_count, last_message, last_message_type, last_message_time, latest_message_id, to_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (conversation_id) DO UPDATE SET
           buyer_name=EXCLUDED.buyer_name, unread_count=EXCLUDED.unread_count,
           last_message=EXCLUDED.last_message, last_message_type=EXCLUDED.last_message_type,
           last_message_time=EXCLUDED.last_message_time, latest_message_id=EXCLUDED.latest_message_id,
           to_id=COALESCE(EXCLUDED.to_id, shopee_chat.to_id),
           updated_at=now()
         RETURNING notified_message_id`,
        [c.conversation_id, storeId, buyer, unread, lastText, c.latest_message_type || null, c.last_message_timestamp || null, latestId, toId]
      );
      const notifiedId = rows[0]?.notified_message_id;
      // last_message_timestamp vem em NANOSSEGUNDOS → ms. Só notifica se < 24h.
      const tsMs = Number(c.last_message_timestamp || 0) / 1e6;
      const recente = tsMs && (Date.now() - tsMs < 24 * 60 * 60 * 1000);
      if (unread > 0 && latestId && latestId !== notifiedId && recente) {
        await tgNotify('tg_mensagens', `💬 <b>Mensagem Shopee não respondida</b>\n👤 ${buyer}\n📩 ${unread} não lida(s)\n📝 ${String(lastText).slice(0, 200)}`);
        await pool.query(`UPDATE shopee_chat SET notified_message_id=$1 WHERE conversation_id=$2`, [latestId, c.conversation_id]);
      } else if (unread > 0 && latestId && latestId !== notifiedId && !recente) {
        // conversa antiga: marca como notificada sem mandar Telegram (evita spam retroativo)
        await pool.query(`UPDATE shopee_chat SET notified_message_id=$1 WHERE conversation_id=$2`, [latestId, c.conversation_id]);
      }
    }
  }
}

// Sincroniza o catálogo Shopee (Product API) → items (campos comuns) +
// shopee_item_data (SKU/variações/preço+estoque por variação). Fonte de preço/
// estoque é o get_model_list (autoritativo). Isolado do pipeline ML.
async function syncShopeeCatalog() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'SHOPEE'`);
  const marketplaceId = mp[0]?.id;
  if (!marketplaceId) return;

  for (const [storeId, client] of shopeeClients) {
    let items;
    try { items = await client.listAllItems('NORMAL', 100); }
    catch (e) { console.warn(`[catalog] loja ${storeId} get_item_list: ${e.message}`); continue; }
    if (!items.length) { console.log(`[catalog] loja ${storeId}: sem itens ativos`); continue; }

    // Detalhe base em lotes de 50 (limite do get_item_base_info).
    const baseById = new Map();
    const ids = items.map((i) => i.item_id);
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const list = await client.getItemsBaseInfo(ids.slice(i, i + 50));
        for (const it of list) baseById.set(it.item_id, it);
      } catch (e) { console.warn(`[catalog] loja ${storeId} base_info: ${e.message}`); }
      await sleep(300);
    }

    let ok = 0;
    for (const it of items) {
      const base = baseById.get(it.item_id);
      if (!base) continue;

      // Preço/estoque/variações via get_model_list (autoritativo — ver diagnóstico).
      let models = [], tier = [];
      try { const ml = await client.getModelList(it.item_id); models = ml.model || []; tier = ml.tier_variation || []; }
      catch (e) { /* segue com o que o base_info tiver */ }
      await sleep(200);

      const prices = models.map((m) => Number(m.price_info?.[0]?.current_price)).filter((n) => !Number.isNaN(n));
      const baseInfoPrice = Number(base.price_info?.[0]?.current_price);
      const priceMin = prices.length ? Math.min(...prices) : (Number.isNaN(baseInfoPrice) ? null : baseInfoPrice);
      const priceMax = prices.length ? Math.max(...prices) : priceMin;
      const stockTotal = models.length
        ? models.reduce((a, m) => a + (Number(m.stock_info_v2?.summary_info?.total_available_stock) || 0), 0)
        : (Number(base.stock_info_v2?.summary_info?.total_available_stock) || 0);
      const modelsCompact = models.map((m) => ({
        model_id: m.model_id, model_name: m.model_name, model_sku: m.model_sku,
        current_price: m.price_info?.[0]?.current_price ?? null,
        original_price: m.price_info?.[0]?.original_price ?? null,
        stock: m.stock_info_v2?.summary_info?.total_available_stock ?? 0,
        model_status: m.model_status,
      }));
      const image = base.image?.image_url_list?.[0] || tier?.[0]?.option_list?.[0]?.image?.image_url || null;
      const status = base.item_status === 'NORMAL' ? 'active' : (base.item_status === 'UNLIST' ? 'paused' : 'closed');
      const catStr = base.category_id != null ? String(base.category_id) : null;

      // Campos COMUNS → items (reaproveita a tabela do ML; anúncios/produtos já leem daqui).
      await pool.query(
        `INSERT INTO items (ml_id, store_id, title, price, available_quantity, status, category_id, thumbnail, marketplace_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (ml_id) DO UPDATE SET
           store_id=EXCLUDED.store_id, title=EXCLUDED.title, price=EXCLUDED.price,
           available_quantity=EXCLUDED.available_quantity, status=EXCLUDED.status,
           category_id=EXCLUDED.category_id, thumbnail=EXCLUDED.thumbnail,
           marketplace_id=EXCLUDED.marketplace_id, updated_at=now()`,
        [String(it.item_id), storeId, base.item_name || null, priceMin, stockTotal, status, catStr, image, marketplaceId]
      );

      // Campos EXCLUSIVOS da Shopee → shopee_item_data.
      await pool.query(
        `INSERT INTO shopee_item_data (item_id, store_id, item_sku, has_model, variation_count, price_min, price_max, stock_total, models, tier_variation, category_id, description, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (item_id) DO UPDATE SET
           store_id=EXCLUDED.store_id, item_sku=EXCLUDED.item_sku, has_model=EXCLUDED.has_model,
           variation_count=EXCLUDED.variation_count, price_min=EXCLUDED.price_min, price_max=EXCLUDED.price_max,
           stock_total=EXCLUDED.stock_total, models=EXCLUDED.models, tier_variation=EXCLUDED.tier_variation,
           category_id=EXCLUDED.category_id, description=EXCLUDED.description, raw=EXCLUDED.raw, updated_at=now()`,
        [String(it.item_id), storeId, base.item_sku || null, !!base.has_model, modelsCompact.length,
         priceMin, priceMax, stockTotal, JSON.stringify(modelsCompact), JSON.stringify(tier),
         base.category_id != null ? base.category_id : null, base.description || null, JSON.stringify(base)]
      );
      ok++;
    }
    console.log(`[catalog] loja ${storeId}: ${ok}/${items.length} itens Shopee sincronizados`);
  }
}

// Resumo legível do desconto de um voucher (reward_type: 1=valor fixo, 2=%).
function voucherDesconto(v) {
  if (Number(v.reward_type) === 2 && v.percentage != null) return `${v.percentage}%`;
  if (v.discount_amount != null) return `R$${v.discount_amount}`;
  return '—';
}

function promoStatus(startS, endS) {
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(startS)) return 'upcoming';
  if (now > Number(endS)) return 'expired';
  return 'ongoing';
}

// Sincroniza promoções Shopee (descontos + vouchers) pra shopee_promotions e
// alerta no Telegram as que vão vencer em < SHOPEE_PROMO_ALERT_HOURS (dedup por
// expiry_notified). Isolado do pipeline ML.
async function syncShopeePromos() {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [storeId, client] of shopeeClients) {
    const promos = [];
    try {
      const [ongoing, upcoming] = await Promise.all([
        client.getDiscountList('ongoing'),
        client.getDiscountList('upcoming'),
      ]);
      for (const d of [...ongoing, ...upcoming]) {
        promos.push({
          tipo: 'discount', promo_id: String(d.discount_id), name: d.discount_name, code: null,
          start_time: d.start_time, end_time: d.end_time, desconto: null,
          status: d.status || promoStatus(d.start_time, d.end_time), raw: d,
        });
      }
    } catch (e) { console.warn(`[promos] loja ${storeId} descontos: ${e.message}`); }

    try {
      const vouchers = await client.getVoucherList('all');
      for (const v of vouchers) {
        if (Number(v.end_time) < nowS) continue; // ignora vouchers já expirados (não polui)
        promos.push({
          tipo: 'voucher', promo_id: String(v.voucher_id), name: v.voucher_name, code: v.voucher_code,
          start_time: v.start_time, end_time: v.end_time, desconto: voucherDesconto(v),
          status: promoStatus(v.start_time, v.end_time), raw: v,
        });
      }
    } catch (e) { console.warn(`[promos] loja ${storeId} vouchers: ${e.message}`); }

    for (const p of promos) {
      const { rows } = await pool.query(
        `INSERT INTO shopee_promotions (tipo, promo_id, store_id, name, code, start_time, end_time, desconto, status, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (tipo, promo_id) DO UPDATE SET
           store_id=EXCLUDED.store_id, name=EXCLUDED.name, code=EXCLUDED.code,
           start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, desconto=EXCLUDED.desconto,
           status=EXCLUDED.status, raw=EXCLUDED.raw, updated_at=now()
         RETURNING expiry_notified`,
        [p.tipo, p.promo_id, storeId, p.name, p.code, p.start_time, p.end_time, p.desconto, p.status, JSON.stringify(p.raw)]
      );
      const jaNotificado = rows[0]?.expiry_notified;
      // Alerta de vencimento: promoção ativa que vence em < X horas e ainda não avisada.
      const faltaHoras = (Number(p.end_time) - nowS) / 3600;
      if (p.status === 'ongoing' && faltaHoras > 0 && faltaHoras <= SHOPEE_PROMO_ALERT_HOURS && !jaNotificado) {
        const fim = new Date(Number(p.end_time) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const tag = p.tipo === 'voucher' ? `🎟️ Voucher ${p.code || ''}` : '🏷️ Desconto';
        await tgNotify('tg_vendas', `⏰ <b>Promoção Shopee vencendo</b>\n${tag}\n📝 ${p.name || ''}${p.desconto ? ` (${p.desconto})` : ''}\n⌛ vence em ${faltaHoras.toFixed(1)}h — ${fim}`);
        await pool.query(`UPDATE shopee_promotions SET expiry_notified = true WHERE tipo=$1 AND promo_id=$2`, [p.tipo, p.promo_id]);
      } else if (faltaHoras > SHOPEE_PROMO_ALERT_HOURS && jaNotificado) {
        // Promoção foi estendida (novo end_time distante) → rearma o alerta.
        await pool.query(`UPDATE shopee_promotions SET expiry_notified = false WHERE tipo=$1 AND promo_id=$2`, [p.tipo, p.promo_id]);
      }
    }
    console.log(`[promos] loja ${storeId}: ${promos.length} promoção(ões) sincronizada(s)`);
  }
}

// Sincroniza devoluções/reembolsos Shopee (Returns API) → shopee_returns e
// alerta no Telegram as novas (< 24h, dedup por notified). Isolado do ML.
async function syncShopeeReturns() {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [storeId, client] of shopeeClients) {
    let returns;
    try { returns = await client.listRecentReturns(SHOPEE_RETURNS_LOOKBACK_DAYS); }
    catch (e) { console.warn(`[returns] loja ${storeId}: ${e.message}`); continue; }
    for (const r of returns || []) {
      if (!r.return_sn) continue;
      const it = (r.item || [])[0] || {};
      const { rows } = await pool.query(
        `INSERT INTO shopee_returns (return_sn, store_id, order_sn, status, reason, text_reason, refund_amount, currency, buyer_username, item_id, item_name, create_time, update_time, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (return_sn) DO UPDATE SET
           status=EXCLUDED.status, text_reason=EXCLUDED.text_reason, refund_amount=EXCLUDED.refund_amount,
           update_time=EXCLUDED.update_time, raw=EXCLUDED.raw, updated_at=now()
         RETURNING notified`,
        [r.return_sn, storeId, r.order_sn || null, r.status || null, r.reason || null, r.text_reason || null,
         r.refund_amount != null ? Number(r.refund_amount) : null, r.currency || null, r.user?.username || null,
         it.item_id != null ? String(it.item_id) : null, it.name || null, r.create_time || null, r.update_time || null, JSON.stringify(r)]
      );
      const notified = rows[0]?.notified;
      const createdMs = Number(r.create_time || 0) * 1000;
      const recente = createdMs && (Date.now() - createdMs < 24 * 60 * 60 * 1000);
      const aberta = !['CANCELLED', 'CLOSED'].includes(r.status);
      if (aberta && recente && !notified) {
        const val = r.refund_amount != null ? `R$ ${Number(r.refund_amount).toFixed(2).replace('.', ',')}` : '';
        await tgNotify('tg_vendas', `↩️ <b>Devolução Shopee</b>\n📦 Pedido ${r.order_sn || ''}\n📝 ${it.name || ''}\n💸 Reembolso ${val}\n🗣️ ${String(r.text_reason || r.reason || '').slice(0, 160)}`);
        await pool.query(`UPDATE shopee_returns SET notified=true WHERE return_sn=$1`, [r.return_sn]);
      } else if (!notified) {
        // devolução antiga: marca como notificada sem mandar Telegram (evita spam retroativo no 1º run)
        await pool.query(`UPDATE shopee_returns SET notified=true WHERE return_sn=$1`, [r.return_sn]);
      }
    }
    console.log(`[returns] loja ${storeId}: ${(returns || []).length} devolução(ões) sincronizada(s)`);
  }
}

module.exports = { startMarketplaceEventWorkers };
