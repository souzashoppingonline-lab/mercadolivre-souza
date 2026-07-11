// Provider de desenvolvimento — gera pedidos fabricados (variados: status,
// datas, valores diferentes a cada execução) para exercitar todo o pipeline
// (fila → marketplaceEventWorker → orders/amazon_order_data → dashboard) sem
// depender do sandbox estático da Amazon, que só devolve um pedido fixo.
//
// Ativado com AMAZON_ENV=mock. Implementa os mesmos contratos que o cliente
// real (MarketplaceClient) e o EventSource real (AmazonPollingEventSource) —
// trocar de volta para a Amazon real é só mudar AMAZON_ENV, sem tocar em
// mais nada do resto do pipeline (marketplaceEventWorker.js, fila, worker.js).
const { EventSource } = require('../interfaces/EventSource');
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { getQueue } = require('../../queues/marketplaceEventQueue');

// Estado em memória compartilhado entre MockEventSource (quem "descobre"/cria
// o pedido) e MockClient (quem responde a getOrder para esse mesmo pedido) —
// preservado enquanto o processo do worker estiver de pé.
const mockOrders = new Map(); // AmazonOrderId → payload no formato da Orders API

const STATUSES = ['Pending', 'Unshipped', 'PartiallyShipped', 'Shipped', 'Canceled'];
const STATUS_WEIGHTS = [0.1, 0.35, 0.1, 0.4, 0.05]; // maioria "paga" (Unshipped/Shipped), poucos cancelados

function weightedStatus() {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < STATUSES.length; i++) {
    acc += STATUS_WEIGHTS[i];
    if (r <= acc) return STATUSES[i];
  }
  return STATUSES[STATUSES.length - 1];
}

function randDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function fakeAmazonOrderId() {
  return `MOCK-${randDigits(3)}-${randDigits(7)}-${randDigits(7)}`;
}

function generateMockOrder() {
  const amazonOrderId = fakeAmazonOrderId();
  const order = {
    AmazonOrderId: amazonOrderId,
    OrderStatus: weightedStatus(),
    PurchaseDate: new Date().toISOString(),
    OrderTotal: { CurrencyCode: 'USD', Amount: (Math.random() * 400 + 20).toFixed(2) },
    FulfillmentChannel: Math.random() < 0.5 ? 'AFN' : 'MFN',
    OrderType: 'StandardOrder',
  };
  mockOrders.set(amazonOrderId, order);
  return order;
}

class MockClient extends MarketplaceClient {
  static get id() { return 'mock'; }

  async refreshAccessToken() { return 'mock-token'; }

  async getOrder(orderId) {
    const order = mockOrders.get(orderId) || generateMockOrder(); // fallback: nunca 404 em dev
    return { payload: order };
  }

  async listRecentOrders() {
    return { payload: { Orders: Array.from(mockOrders.values()) } };
  }
}

class MockEventSource extends EventSource {
  // store: mesma linha de `stores` que uma AmazonPollingEventSource real
  // receberia — só usamos o id, pra marcar o evento com a conta certa.
  constructor(store) {
    super();
    this.store = store;
  }

  async start() {
    console.log(`[mock-provider] MockEventSource ativo (${this.store.nickname}) — gerando pedidos de teste variados`);
  }

  async stop() {}

  // Cada execução tem ~70% de chance de "descobrir" 1 pedido novo — imita a
  // cadência irregular de vendas reais, sem gerar ruído a cada tick.
  async discoverEvents() {
    if (Math.random() > 0.7) return;
    const order = generateMockOrder();
    const jobId = `AMAZON:${this.store.id}:ORDER_UPDATED:${order.AmazonOrderId}`;
    await getQueue('amazon').add('marketplace-event', {
      marketplace: 'AMAZON',
      event: 'ORDER_UPDATED',
      resourceId: order.AmazonOrderId,
      storeId: this.store.id,
      sellerId: 'mock',
      timestamp: new Date().toISOString(),
    }, { jobId });
    console.log(`[mock-provider] pedido de teste gerado: ${order.AmazonOrderId} (${order.OrderStatus}, $${order.OrderTotal.Amount})`);
  }
}

module.exports = { MockClient, MockEventSource };
