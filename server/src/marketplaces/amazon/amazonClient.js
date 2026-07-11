// Cliente Amazon SP-API (Selling Partner API) — segue o mesmo contrato de
// server/src/marketplaces/interfaces/MarketplaceClient.js.
//
// Uso restrito: só deve ser chamado por um worker/adapter dedicado, nunca
// por rotas de leitura do dashboard — mesma regra de fronteira usada para
// mlClient.js (ver .claude/architecture.md, regra 2-3).
//
// AINDA NÃO CONECTADO a server.js/worker.js/routes — este arquivo só existe
// isolado até a decisão de schema (coluna `marketplace` discriminadora) ser
// confirmada. Ver .claude/decisions.md e .claude/roadmap.md.
//
// Credenciais — SOMENTE via variáveis de ambiente (server/.env), nunca hardcoded:
//   AMAZON_APP_ID              — "amzn1.sp.solution.xxxx" (Application ID do Developer Console;
//                                 NÃO é o mesmo que AMAZON_LWA_CLIENT_ID)
//   AMAZON_LWA_CLIENT_ID       — Client ID da Login with Amazon (necessário p/ trocar o refresh token)
//   AMAZON_LWA_CLIENT_SECRET   — Client Secret da Login with Amazon
//   AMAZON_REFRESH_TOKEN       — refresh token (prefixo "Atzr|") obtido na autorização do seller
//   AMAZON_MARKETPLACE_ID      — ex: A2Q3Y263D00KWC (Brasil)
//   AMAZON_REGION              — na | eu | fe (Brasil = na)
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError } = require('../base/errors');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

const SPAPI_ENDPOINTS = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

class AmazonClient extends MarketplaceClient {
  static get id() { return 'amazon'; }

  constructor(env) {
    super();
    this.cfg = env.amazon;
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
  }

  _assertConfigured() {
    const missing = ['lwaClientId', 'lwaClientSecret', 'refreshToken', 'marketplaceId']
      .filter((k) => !this.cfg?.[k]);
    if (missing.length) {
      throw new MarketplaceTokenInvalidError(
        `Amazon não configurada — variáveis faltando: ${missing.map((k) => `AMAZON_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`).join(', ')}`
      );
    }
  }

  // Troca o refresh token por um access token de curta duração (LWA).
  // Não precisa de storeId — a Amazon usa um refresh token por seller autorizado,
  // e hoje só temos uma conta configurada via .env (ver known-bugs.md se isso mudar).
  async refreshAccessToken() {
    this._assertConfigured();
    if (this._accessToken && Date.now() < this._accessTokenExpiresAt - 60000) {
      return this._accessToken;
    }

    const res = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.cfg.refreshToken,
        client_id: this.cfg.lwaClientId,
        client_secret: this.cfg.lwaClientSecret,
      }),
    });

    if (res.status === 429) {
      throw new MarketplaceRateLimitError('Amazon LWA token endpoint rate limited');
    }
    if (res.status === 400 || res.status === 401) {
      const body = await res.text();
      throw new MarketplaceTokenInvalidError(`Amazon LWA refresh falhou (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new MarketplaceTransientError(`Amazon LWA HTTP ${res.status}`);
    }

    const tokens = await res.json();
    this._accessToken = tokens.access_token;
    this._accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    return this._accessToken;
  }

  async _get(path) {
    const token = await this.refreshAccessToken();
    const region = this.cfg.region || 'na';
    const base = SPAPI_ENDPOINTS[region];
    if (!base) throw new Error(`Região Amazon inválida: ${region}`);

    const res = await fetch(`${base}${path}`, {
      headers: { 'x-amz-access-token': token },
    });

    if (res.status === 429) throw new MarketplaceRateLimitError(`SP-API ${path} rate limited`);
    if (res.status >= 500) throw new MarketplaceTransientError(`SP-API ${path} HTTP ${res.status}`);
    if (!res.ok) throw new Error(`SP-API ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async getOrder(orderId) {
    return this._get(`/orders/v0/orders/${orderId}`);
  }

  // sinceISODate: ISO 8601 — equivalente ao dateFrom usado em ml.searchOrders (mercadolivre.md)
  async listRecentOrders(sinceISODate) {
    const qs = new URLSearchParams({
      MarketplaceIds: this.cfg.marketplaceId,
      CreatedAfter: sinceISODate,
    });
    return this._get(`/orders/v0/orders?${qs}`);
  }
}

module.exports = { AmazonClient, SPAPI_ENDPOINTS };
