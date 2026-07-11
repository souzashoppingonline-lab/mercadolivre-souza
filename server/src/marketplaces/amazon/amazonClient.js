// Cliente Amazon SP-API (Selling Partner API) — segue o mesmo contrato de
// server/src/marketplaces/interfaces/MarketplaceClient.js.
//
// Uso restrito: só deve ser chamado por um worker/adapter dedicado, nunca
// por rotas de leitura do dashboard — mesma regra de fronteira usada para
// mlClient.js (ver .claude/architecture.md, regra 2-3).
//
// Suporta múltiplas contas Amazon: o construtor recebe um `cfg` já mesclado
// (não o objeto `env` inteiro) — quem instancia (AmazonPollingEventSource,
// marketplaceEventWorker.js) monta esse cfg combinando a linha de `stores`
// da conta (refresh_token, amazon_marketplace_id, amazon_region) com os
// defaults globais de server/.env. Ver .claude/decisions.md.
//
// Campos esperados em `cfg` (mesmos nomes de server/.env, sem prefixo AMAZON_):
//   lwaClientId, lwaClientSecret  — compartilhados entre todas as contas
//                                    (identificam o app, não o seller)
//   refreshToken                  — por conta (prefixo "Atzr|")
//   marketplaceId                 — ex: A2Q3Y263D00KWC (Brasil) — por conta
//   region                        — na | eu | fe (Brasil = na) — por conta
//   env                           — sandbox | production | mock — global (AMAZON_ENV)
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError } = require('../base/errors');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'; // mesmo endpoint para sandbox e produção

// Sandbox devolve dados de teste estáticos (não pedidos reais) — serve para validar
// autenticação/formato de chamada antes da aprovação de acesso de produção pela Amazon.
const SPAPI_ENDPOINTS = {
  production: {
    na: 'https://sellingpartnerapi-na.amazon.com',
    eu: 'https://sellingpartnerapi-eu.amazon.com',
    fe: 'https://sellingpartnerapi-fe.amazon.com',
  },
  sandbox: {
    na: 'https://sandbox.sellingpartnerapi-na.amazon.com',
    eu: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
    fe: 'https://sandbox.sellingpartnerapi-fe.amazon.com',
  },
};

class AmazonClient extends MarketplaceClient {
  static get id() { return 'amazon'; }

  constructor(cfg) {
    super();
    this.cfg = cfg;
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
  // Cada conta tem sua própria instância de AmazonClient (cfg.refreshToken
  // já é o dessa conta), então o cache de access token em memória
  // (_accessToken/_accessTokenExpiresAt) é naturalmente isolado por conta.
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
    const env = this.cfg.env === 'production' ? 'production' : 'sandbox';
    const base = SPAPI_ENDPOINTS[env]?.[region];
    if (!base) throw new Error(`Região/ambiente Amazon inválido: env=${env} region=${region}`);

    const res = await fetch(`${base}${path}`, {
      headers: { 'x-amz-access-token': token },
    });

    if (res.status === 429) throw new MarketplaceRateLimitError(`SP-API ${path} rate limited`);
    if (res.status >= 500) throw new MarketplaceTransientError(`SP-API ${path} HTTP ${res.status}`);
    if (!res.ok) throw new Error(`SP-API ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // O sandbox estático também exige um literal de teste no path (não o
  // AmazonOrderId real devolvido por listRecentOrders) — "TEST_CASE_200"
  // devolve sempre o mesmo pedido fixo (AmazonOrderId "902-1845936-5435065").
  // Confirmado no modelo oficial da SP-API (ordersV0.json, x-amzn-api-sandbox.static).
  async getOrder(orderId) {
    const isSandbox = this.cfg.env !== 'production';
    return this._get(`/orders/v0/orders/${isSandbox ? 'TEST_CASE_200' : orderId}`);
  }

  // sinceISODate: ISO 8601 — equivalente ao dateFrom usado em ml.searchOrders (mercadolivre.md)
  //
  // O sandbox ESTÁTICO da Amazon não aceita data/marketplace reais — ele só
  // reconhece por pattern-matching os valores literais documentados
  // (CreatedAfter=TEST_CASE_200, MarketplaceIds=ATVPDKIKX0DER), devolvendo
  // sempre o mesmo pedido de teste fixo. Qualquer outro valor retorna
  // 400 InvalidInput "Could not match input arguments". Em produção usamos
  // os valores reais normalmente.
  async listRecentOrders(sinceISODate) {
    const isSandbox = this.cfg.env !== 'production';
    const qs = new URLSearchParams({
      MarketplaceIds: isSandbox ? 'ATVPDKIKX0DER' : this.cfg.marketplaceId,
      CreatedAfter: isSandbox ? 'TEST_CASE_200' : sinceISODate,
    });
    return this._get(`/orders/v0/orders?${qs}`);
  }
}

module.exports = { AmazonClient, SPAPI_ENDPOINTS };
