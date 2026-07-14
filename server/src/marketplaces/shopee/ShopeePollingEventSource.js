// Implementação do padrão EventSource para a Shopee — fase 1 usa polling
// periódico (mesmo padrão já validado com a Amazon), mesmo a Shopee expondo
// "Mecanismo de Empurra" (webhook) — migrar para push fica para uma fase 2,
// depois de confirmar o contrato exato de push no console (ver .claude/shopee.md).
// O Worker que consome os eventos (server/src/marketplaceEventWorker.js) não
// sabe que a origem foi polling — só reage ao formato padronizado do evento.
//
// Uma instância por conta Shopee (uma linha em `stores` com
// marketplace_id=SHOPEE) — quem cria as instâncias e chama startAll() é
// server/src/marketplaceEventWorker.js, que itera todas as contas cadastradas.
const { EventSource } = require('../interfaces/EventSource');
const { ShopeeClient } = require('./shopeeClient');
const { getQueue } = require('../../queues/marketplaceEventQueue');
const pool = require('../../db/pool');
const env = require('../../config/env');

class ShopeePollingEventSource extends EventSource {
  // store: linha de `stores` da conta (id, nickname, shopee_shop_id,
  // access_token, refresh_token, token_expires_at).
  constructor(store) {
    super();
    this.store = store;
    this.sourceKey = String(store.id);
    this.client = new ShopeeClient({
      ...env.shopee,
      shopId: store.shopee_shop_id,
      accessToken: store.access_token,
      refreshToken: store.refresh_token,
    });
    this.tokenExpiresAt = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
    this.marketplaceId = null;
  }

  async start() {
    const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'SHOPEE'`);
    this.marketplaceId = rows[0]?.id || null;
    if (!this.marketplaceId) {
      console.warn('[shopee-polling] marketplace SHOPEE não encontrado em `marketplaces` — rode a migration.');
    }
  }

  async stop() {}

  // Renova o access_token proativamente (margem de 10min) quando necessário.
  // A Shopee rotaciona o refresh_token a cada renovação — grava com CAS
  // (WHERE refresh_token = valor lido ao construir esta instância) pra não
  // sobrescrever um token mais novo salvo por outro processo em paralelo
  // (mesmo padrão de routes/auth.js pro Mercado Livre, ver .claude/decisions.md).
  async _ensureValidToken() {
    const safetyMarginMs = 10 * 60 * 1000;
    if (Date.now() < this.tokenExpiresAt - safetyMarginMs) return;
    try {
      const tokens = await this.client.refreshAccessToken();
      this.tokenExpiresAt = Date.now() + Number(tokens.expire_in || 14400) * 1000;
      const { rowCount } = await pool.query(
        `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now()
         WHERE id=$1 AND refresh_token=$5`,
        [this.store.id, tokens.access_token, tokens.refresh_token, new Date(this.tokenExpiresAt), this.store.refresh_token]
      );
      if (rowCount === 0) {
        console.warn(`[shopee-polling] (${this.store.nickname}) CAS de refresh_token não bateu — outro processo já renovou; recarregando`);
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
      console.warn(`[shopee-polling] (${this.store.nickname}) refresh de token falhou:`, e.message);
    }
  }

  async discoverEvents() {
    if (!this.client.cfg?.shopId) return; // não configurada — no-op silencioso, mesma postura do shopeeClient.js
    if (!this.marketplaceId) await this.start();
    await this._ensureValidToken();

    const since = await this._getLastSyncedAt();
    const startedAt = new Date();

    let orders;
    try {
      orders = await this.client.listRecentOrders(since.toISOString());
    } catch (e) {
      console.warn(`[shopee-polling] (${this.store.nickname}) listRecentOrders falhou:`, e.message);
      return;
    }

    const queue = getQueue('shopee');
    for (const o of orders) {
      if (!o.order_sn) continue;
      // BullMQ exige que um jobId customizado com ':' tenha exatamente 2
      // (mesma regra já documentada em .claude/known-bugs.md para a Amazon).
      const jobId = `SHOPEE:ORDER_UPDATED:${this.store.id}-${o.order_sn}`;
      await queue.add('marketplace-event', {
        marketplace: 'SHOPEE',
        event: 'ORDER_UPDATED',
        resourceId: o.order_sn,
        storeId: this.store.id, // chave de roteamento — qual client/store usar no consumidor
        timestamp: new Date().toISOString(),
      }, { jobId });
    }

    if (orders.length) console.log(`[shopee-polling] (${this.store.nickname}) ${orders.length} pedido(s) descobertos desde ${since.toISOString()}`);
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

module.exports = { ShopeePollingEventSource };
