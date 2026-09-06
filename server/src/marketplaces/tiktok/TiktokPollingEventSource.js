// Implementação do padrão EventSource para o TikTok Shop — polling
// periódico (mesmo padrão validado com Amazon/Shopee), MAIS um webhook em
// tempo real (ver server/src/routes/tiktokWebhook.js) — mesma dupla defesa
// já usada pela Shopee (polling nunca é desligado, webhook só acelera).
// O Worker que consome os eventos (server/src/marketplaceEventWorker.js)
// não sabe que a origem foi polling — só reage ao formato padronizado.
//
// Uma instância por conta TikTok Shop (uma linha em `stores` com
// marketplace_id=TIKTOK) — quem cria as instâncias e chama startAll() é
// server/src/marketplaceEventWorker.js.
const { EventSource } = require('../interfaces/EventSource');
const { TiktokClient } = require('./tiktokClient');
const { getQueue } = require('../../queues/marketplaceEventQueue');
const pool = require('../../db/pool');
const env = require('../../config/env');

class TiktokPollingEventSource extends EventSource {
  // store: linha de `stores` da conta (id, nickname, tiktok_shop_id,
  // tiktok_shop_cipher, access_token, refresh_token, token_expires_at).
  constructor(store) {
    super();
    this.store = store;
    this.sourceKey = String(store.id);
    this.client = new TiktokClient({
      appKey: env.tiktok.appKey,
      appSecret: env.tiktok.appSecret,
      accessToken: store.access_token,
      refreshToken: store.refresh_token,
      shopCipher: store.tiktok_shop_cipher,
    });
    this.tokenExpiresAt = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
    this.marketplaceId = null;
  }

  async start() {
    const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'TIKTOK'`);
    this.marketplaceId = rows[0]?.id || null;
    if (!this.marketplaceId) {
      console.warn('[tiktok-polling] marketplace TIKTOK não encontrado em `marketplaces` — rode a migration.');
    }
  }

  async stop() {}

  // Renova o access_token proativamente (margem de 10min). CAS igual ao
  // usado para Shopee/ML — evita corrida entre dois processos renovando ao
  // mesmo tempo (ver .claude/decisions.md).
  async _ensureValidToken() {
    const safetyMarginMs = 10 * 60 * 1000;
    if (Date.now() < this.tokenExpiresAt - safetyMarginMs) return;
    try {
      const tokens = await this.client.refreshAccessToken();
      this.tokenExpiresAt = Date.now() + Number(tokens.access_token_expire_in || 7 * 24 * 3600) * 1000;
      const { rowCount } = await pool.query(
        `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now()
         WHERE id=$1 AND refresh_token=$5`,
        [this.store.id, tokens.access_token, tokens.refresh_token, new Date(this.tokenExpiresAt), this.store.refresh_token]
      );
      if (rowCount === 0) {
        console.warn(`[tiktok-polling] (${this.store.nickname}) CAS de refresh_token não bateu — outro processo já renovou; recarregando`);
        const { rows } = await pool.query(`SELECT access_token, refresh_token, token_expires_at FROM stores WHERE id=$1`, [this.store.id]);
        if (rows[0]) {
          this.store.access_token = this.client.cfg.accessToken = rows[0].access_token;
          this.store.refresh_token = this.client.cfg.refreshToken = rows[0].refresh_token;
          this.tokenExpiresAt = new Date(rows[0].token_expires_at).getTime();
        }
      } else {
        this.store.refresh_token = tokens.refresh_token;
      }
    } catch (e) {
      console.warn(`[tiktok-polling] (${this.store.nickname}) refresh de token falhou:`, e.message);
    }
  }

  async discoverEvents() {
    if (!this.client.cfg?.shopCipher) return; // não configurada — no-op silencioso, mesma postura do shopeeClient.js
    if (!this.marketplaceId) await this.start();
    await this._ensureValidToken();

    const since = await this._getLastSyncedAt();
    const startedAt = new Date();

    let orders;
    try {
      orders = await this.client.listRecentOrders(since.toISOString());
    } catch (e) {
      console.warn(`[tiktok-polling] (${this.store.nickname}) listRecentOrders falhou:`, e.message);
      return;
    }

    const queue = getQueue('tiktok');
    for (const o of orders) {
      const orderId = o.id || o.order_id; // ⚠️ nome do campo a confirmar (ver tiktokClient.js)
      if (!orderId) continue;
      const jobId = `TIKTOK:ORDER_UPDATED:${this.store.id}-${orderId}`;
      await queue.add('marketplace-event', {
        marketplace: 'TIKTOK',
        event: 'ORDER_UPDATED',
        resourceId: orderId,
        storeId: this.store.id,
        timestamp: new Date().toISOString(),
      }, { jobId });
    }

    if (orders.length) console.log(`[tiktok-polling] (${this.store.nickname}) ${orders.length} pedido(s) descobertos desde ${since.toISOString()}`);
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

module.exports = { TiktokPollingEventSource };
