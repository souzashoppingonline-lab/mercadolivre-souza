// Consome eventos padronizados publicados por EventSources de marketplace
// (hoje: AmazonPollingEventSource, uma instância por conta Amazon cadastrada
// em `stores`) numa fila BullMQ própria, totalmente desacoplada do dispatch
// table `handlers`/`processJob` do Mercado Livre em worker.js — este arquivo
// não altera nenhuma linha do pipeline ML existente.
// Ver .claude/decisions.md ("Marketplace Engine — EventSource").
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const pool = require('./db/pool');
const redis = require('./db/redis');
const { publish } = require('./ws/hub');
const { Scheduler } = require('./marketplaces/Scheduler');
const { AmazonPollingEventSource } = require('./marketplaces/amazon/AmazonPollingEventSource');
const { MockClient, MockEventSource } = require('./marketplaces/mock/mockProvider');

const AMAZON_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min — ajustável sem tocar no restante do pipeline
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

async function startMarketplaceEventWorkers() {
  const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false });
  const w = new Worker('marketplace-events-amazon', (job) => handleOrderEvent(job.data), {
    connection,
    concurrency: 2,
  });
  w.on('failed', (job, err) => console.error('[marketplace-worker] failed', job?.id, err.message));
  w.on('error', (err) => console.error('[marketplace-worker] error:', err.message));
  console.log('[marketplace-worker] started queue marketplace-events-amazon');

  // Uma EventSource por conta Amazon cadastrada — suporta múltiplas contas
  // (cada linha de `stores` com marketplace_id=AMAZON é uma conta), não só a
  // store sentinela original. Ver .claude/decisions.md.
  const { rows: amazonStores } = await pool.query(
    `SELECT id, nickname, refresh_token, amazon_marketplace_id, amazon_region
     FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'AMAZON')`
  );
  if (!amazonStores.length) {
    console.warn('[marketplace-worker] nenhuma conta Amazon cadastrada em `stores` — nada para sincronizar');
    return;
  }

  const scheduler = new Scheduler();
  const mockClient = isMock ? new MockClient() : null; // stateless o bastante pra ser compartilhado entre contas
  for (const store of amazonStores) {
    const source = isMock ? new MockEventSource(store) : new AmazonPollingEventSource(store);
    clients.set(store.id, isMock ? mockClient : source.client);
    scheduler.register(source, { intervalMs: isMock ? MOCK_POLL_INTERVAL_MS : AMAZON_POLL_INTERVAL_MS });
    console.log(`[marketplace-worker] conta Amazon registrada: ${store.nickname} (store_id=${store.id})`);
  }
  scheduler.startAll().catch((err) => console.error('[marketplace-worker] scheduler startAll falhou:', err.message));
}

module.exports = { startMarketplaceEventWorkers };
