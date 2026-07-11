// Implementação real do padrão EventSource para a Amazon — a SP-API não tem
// um webhook simples "topic+resource" como o Mercado Livre, então a
// descoberta de pedidos novos/alterados é por polling periódico (equivalente
// ao syncVendas do ML), publicando eventos padronizados numa fila BullMQ.
// O Worker que consome esses eventos (server/src/marketplaceEventWorker.js)
// não sabe que a origem foi polling — só reage ao formato do evento.
const { EventSource } = require('../interfaces/EventSource');
const { AmazonClient } = require('./amazonClient');
const { getQueue } = require('../../queues/marketplaceEventQueue');
const pool = require('../../db/pool');
const env = require('../../config/env');

const SOURCE_KEY = 'default'; // só uma conta Amazon configurada via .env hoje

class AmazonPollingEventSource extends EventSource {
  constructor() {
    super();
    this.client = new AmazonClient(env);
    this.marketplaceId = null;
  }

  async start() {
    const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'AMAZON'`);
    this.marketplaceId = rows[0]?.id || null;
    if (!this.marketplaceId) {
      console.warn('[amazon-polling] marketplace AMAZON não encontrado em `marketplaces` — rode a migration.');
    }
  }

  async stop() {}

  async discoverEvents() {
    if (!env.amazon?.lwaClientId) return; // não configurada — no-op silencioso, mesma postura do amazonClient.js
    if (!this.marketplaceId) await this.start();

    const since = await this._getLastSyncedAt();
    const startedAt = new Date();

    let orders;
    try {
      orders = await this.client.listRecentOrders(since.toISOString());
    } catch (e) {
      console.warn('[amazon-polling] listRecentOrders falhou:', e.message);
      return;
    }

    const list = orders?.payload?.Orders || [];
    const queue = getQueue('amazon');
    for (const o of list) {
      if (!o.AmazonOrderId) continue;
      const jobId = `AMAZON:ORDER_UPDATED:${o.AmazonOrderId}`;
      await queue.add('marketplace-event', {
        marketplace: 'AMAZON',
        event: 'ORDER_UPDATED',
        resourceId: o.AmazonOrderId,
        sellerId: SOURCE_KEY,
        timestamp: new Date().toISOString(),
      }, { jobId });
    }

    if (list.length) console.log(`[amazon-polling] ${list.length} pedido(s) descobertos desde ${since.toISOString()}`);
    await this._setLastSyncedAt(startedAt);
  }

  async _getLastSyncedAt() {
    const { rows } = await pool.query(
      `SELECT last_synced_at FROM marketplace_sync_state WHERE marketplace_id = $1 AND source_key = $2`,
      [this.marketplaceId, SOURCE_KEY]
    );
    if (rows[0]?.last_synced_at) return new Date(rows[0].last_synced_at);
    return new Date(Date.now() - 24 * 60 * 60 * 1000); // 1ª execução: olha as últimas 24h
  }

  async _setLastSyncedAt(date) {
    await pool.query(
      `INSERT INTO marketplace_sync_state (marketplace_id, source_key, last_synced_at, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (marketplace_id, source_key) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at, updated_at = now()`,
      [this.marketplaceId, SOURCE_KEY, date.toISOString()]
    );
  }
}

module.exports = { AmazonPollingEventSource };
