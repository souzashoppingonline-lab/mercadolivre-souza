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
const { Scheduler } = require('./marketplaces/Scheduler');
const { AmazonPollingEventSource } = require('./marketplaces/amazon/AmazonPollingEventSource');
const { ShopeePollingEventSource } = require('./marketplaces/shopee/ShopeePollingEventSource');
const { MockClient, MockEventSource } = require('./marketplaces/mock/mockProvider');

const AMAZON_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min — ajustável sem tocar no restante do pipeline
const SHOPEE_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min — mesmo intervalo da Amazon na fase 1 (polling)
const MOCK_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2min — mais rápido para dar feedback visível em dev

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

  // Rastreio (tracking) — só existe depois que o pedido é preparado pra envio.
  // Busca sob-demanda pra Embalagem casar a etiqueta bipada (QR = tracking) com
  // o pedido. Se ainda não tiver, não sobrescreve o que já estava (COALESCE).
  let trackingNumber = null;
  if (SHOPEE_SHIPPABLE.has(o.order_status)) {
    try { trackingNumber = await client.getTrackingNumber(o.order_sn); }
    catch (e) { console.warn(`[marketplace-worker] tracking Shopee ${o.order_sn}: ${e.message}`); }
  }

  await pool.query(
    `INSERT INTO shopee_order_data (order_id, order_sn, shop_id, buyer_username, order_status, raw_data, tracking_number, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (order_id) DO UPDATE SET
       shop_id = EXCLUDED.shop_id,
       buyer_username = EXCLUDED.buyer_username,
       order_status = EXCLUDED.order_status,
       raw_data = EXCLUDED.raw_data,
       tracking_number = COALESCE(EXCLUDED.tracking_number, shopee_order_data.tracking_number),
       updated_at = now()`,
    [o.order_sn, o.order_sn, client.cfg?.shopId || null, o.buyer_username || null, o.order_status || null, JSON.stringify(o), trackingNumber]
  );

  await redis.del('kpis:summary');
  await publish('order_updated', { id: o.order_sn, status, marketplace: 'SHOPEE', storeId: evt.storeId });

  if (status === 'paid' && previousStatus !== 'paid') {
    console.log(`[marketplace-worker] ✅ nova venda Shopee (store_id=${evt.storeId}): ${o.order_sn} | R$ ${totalAmount}`);
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
}

module.exports = { startMarketplaceEventWorkers };
