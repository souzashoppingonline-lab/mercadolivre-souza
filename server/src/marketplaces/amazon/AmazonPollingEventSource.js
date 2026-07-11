// Implementação real do padrão EventSource para a Amazon — a SP-API não tem
// um webhook simples "topic+resource" como o Mercado Livre, então a
// descoberta de pedidos novos/alterados é por polling periódico (equivalente
// ao syncVendas do ML), publicando eventos padronizados numa fila BullMQ.
// O Worker que consome esses eventos (server/src/marketplaceEventWorker.js)
// não sabe que a origem foi polling — só reage ao formato do evento.
//
// Uma instância por conta Amazon (uma linha em `stores` com
// marketplace_id=AMAZON) — quem cria as instâncias e chama startAll() é
// server/src/marketplaceEventWorker.js, que itera todas as contas cadastradas.
const { EventSource } = require('../interfaces/EventSource');
const { AmazonClient } = require('./amazonClient');
const { getQueue } = require('../../queues/marketplaceEventQueue');
const pool = require('../../db/pool');
const env = require('../../config/env');

class AmazonPollingEventSource extends EventSource {
  // store: linha de `stores` da conta (id, nickname, refresh_token,
  // amazon_marketplace_id, amazon_region) — colunas específicas da conta
  // sobrepõem os defaults globais de server/.env quando não forem NULL,
  // mesmo padrão de ml_client_id/ml_client_secret já usado para o ML.
  constructor(store) {
    super();
    this.store = store;
    this.sourceKey = String(store.id);
    this.client = new AmazonClient({
      ...env.amazon,
      refreshToken: store.refresh_token || env.amazon.refreshToken,
      marketplaceId: store.amazon_marketplace_id || env.amazon.marketplaceId,
      region: store.amazon_region || env.amazon.region,
    });
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
    if (!this.client.cfg?.lwaClientId) return; // não configurada — no-op silencioso, mesma postura do amazonClient.js
    if (!this.marketplaceId) await this.start();

    const since = await this._getLastSyncedAt();
    const startedAt = new Date();

    let orders;
    try {
      orders = await this.client.listRecentOrders(since.toISOString());
    } catch (e) {
      console.warn(`[amazon-polling] (${this.store.nickname}) listRecentOrders falhou:`, e.message);
      return;
    }

    const list = orders?.payload?.Orders || [];
    const queue = getQueue('amazon');
    for (const o of list) {
      if (!o.AmazonOrderId) continue;
      // BullMQ exige que um jobId customizado com ':' tenha exatamente 2
      // (3 partes) — por isso storeId+orderId ficam combinados com '-' no
      // 3º segmento, em vez de um 3º ':' separado (ver .claude/known-bugs.md).
      const jobId = `AMAZON:ORDER_UPDATED:${this.store.id}-${o.AmazonOrderId}`;
      await queue.add('marketplace-event', {
        marketplace: 'AMAZON',
        event: 'ORDER_UPDATED',
        resourceId: o.AmazonOrderId,
        storeId: this.store.id, // chave de roteamento — qual client/store usar no consumidor
        sellerId: this.sourceKey,
        timestamp: new Date().toISOString(),
      }, { jobId });
    }

    if (list.length) console.log(`[amazon-polling] (${this.store.nickname}) ${list.length} pedido(s) descobertos desde ${since.toISOString()}`);
    await this._setLastSyncedAt(startedAt);
  }

  async _getLastSyncedAt() {
    const { rows } = await pool.query(
      `SELECT last_synced_at FROM marketplace_sync_state WHERE marketplace_id = $1 AND source_key = $2`,
      [this.marketplaceId, this.sourceKey]
    );
    if (rows[0]?.last_synced_at) return new Date(rows[0].last_synced_at);
    return new Date(Date.now() - 24 * 60 * 60 * 1000); // 1ª execução: olha as últimas 24h
  }

  async _setLastSyncedAt(date) {
    await pool.query(
      `INSERT INTO marketplace_sync_state (marketplace_id, source_key, last_synced_at, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (marketplace_id, source_key) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at, updated_at = now()`,
      [this.marketplaceId, this.sourceKey, date.toISOString()]
    );
  }
}

module.exports = { AmazonPollingEventSource };
