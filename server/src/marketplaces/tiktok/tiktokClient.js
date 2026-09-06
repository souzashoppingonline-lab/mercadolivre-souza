// Cliente TikTok Shop Partner API — segue o mesmo contrato de
// server/src/marketplaces/interfaces/MarketplaceClient.js (mesmo molde de
// shopeeClient.js/amazonClient.js).
//
// Uso restrito: só deve ser chamado por um worker/adapter dedicado, nunca
// por rotas de leitura do dashboard — mesma regra de fronteira de
// mlClient.js/shopeeClient.js/amazonClient.js (ver .claude/architecture.md).
//
// ⚠️ FASE 1 — endpoints confirmados via documentação pública (busca web, o
// domínio partner.tiktokshop.com está bloqueado pelo proxy de saída deste
// ambiente e não pôde ser lido direto). Os 2 pontos abaixo precisam de
// confirmação final assim que o app estiver criado no Partner Center — ver
// .claude/tiktok.md "O que falta confirmar":
//   1. getAuthorizationUrl() — Custom App costuma ter link de autorização
//      pronto no próprio Partner Center; a URL construída aqui é o padrão
//      documentado, mas comparar com o link real da tela do app antes de
//      usar em produção.
//   2. Nomes exatos dos campos do pedido na resposta de /order/202309/orders/search
//      (o handler abaixo assume nomes prováveis — ex. order_id/order_status/
//      payment.total_amount — baseados no padrão do resto da API, mas
//      DEVEM ser confirmados contra uma resposta real antes de confiar nos
//      dados).
// Nunca "adivinhar" além disso — mesma disciplina já usada para a Shopee.
const crypto = require('crypto');
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError } = require('../base/errors');

const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = 'https://auth.tiktok-shops.com';
const AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';
const ORDER_API_VERSION = '202309'; // API versionada por data no path — confirmar se a Partner Center já pede uma versão mais nova ao criar o app

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Assinatura de request de negócio (Shop API) — DIFERENTE da assinatura de
// webhook (ver tiktokWebhook.js). HMAC-SHA256(app_secret, path + query_ordenada
// + body), hex minúsculo, enviada como parâmetro `sign` na query string.
// Confirmado via documentação pública ("Sign your API request").
function sign({ appSecret, path, query = {}, body }) {
  const sortedKeys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  let base = path;
  for (const k of sortedKeys) base += `${k}${query[k]}`;
  base = `${appSecret}${base}`;
  if (body && typeof body === 'object' && Object.keys(body).length) base += JSON.stringify(body);
  base += appSecret;
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex');
}

// Monta a URL pra onde o vendedor deve ser redirecionado pra autorizar o app.
// Ver aviso no topo do arquivo — Custom App pode ter um link pronto no
// Partner Center; comparar antes de usar em produção.
function getAuthorizationUrl({ appKey, redirectUri }) {
  const qs = new URLSearchParams({ service_id: appKey, redirect_uri: redirectUri });
  return `${AUTHORIZE_URL}?${qs}`;
}

// Troca o `code` (recebido no redirect_uri após o vendedor aprovar) por
// access_token/refresh_token. GET direto (sem assinatura HMAC — só o
// endpoint de token funciona assim; todo o resto da API exige `sign`).
async function exchangeCodeForToken({ appKey, appSecret, code }) {
  const qs = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code' });
  const res = await fetch(`${AUTH_BASE}/api/v2/token/get?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code) {
    throw new MarketplaceTokenInvalidError(`TikTok token/get falhou: ${body.code || res.status} — ${body.message || ''}`);
  }
  return body.data || body; // { access_token, refresh_token, access_token_expire_in, shop_id/seller_name conforme escopo autorizado }
}

class TiktokClient extends MarketplaceClient {
  static get id() { return 'tiktok'; }

  constructor(cfg) {
    super();
    this.cfg = cfg; // { appKey, appSecret, accessToken, refreshToken, shopId, shopCipher }
  }

  _assertConfigured() {
    const missing = [];
    if (!this.cfg?.appKey) missing.push('appKey');
    if (!this.cfg?.appSecret) missing.push('appSecret');
    if (!this.cfg?.accessToken) missing.push('accessToken');
    if (!this.cfg?.shopCipher) missing.push('shopCipher'); // identificador de loja exigido pela maioria dos endpoints Shop API
    if (missing.length) {
      throw new MarketplaceTokenInvalidError(`TikTok Shop não configurado para esta conta — faltando: ${missing.join(', ')}`);
    }
  }

  // Chamada assinada à Shop API. `query` entra no `sign`; `shop_cipher`/
  // `app_key`/`timestamp`/`access_token`/`sign` sempre vão na query string
  // (nunca no header) — mesmo padrão documentado ("Sign your API request").
  async _call(path, { method = 'GET', body, query = {} } = {}) {
    const { appKey, appSecret, accessToken, shopCipher } = this.cfg;
    const timestamp = String(nowSeconds());
    const fullQuery = { app_key: appKey, timestamp, shop_cipher: shopCipher, ...query };
    const signature = sign({ appSecret, path, query: fullQuery, body });
    const qs = new URLSearchParams({ ...fullQuery, sign: signature });

    const res = await fetch(`${API_BASE}${path}?${qs}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    });

    if (res.status === 429) throw new MarketplaceRateLimitError(`TikTok ${path} rate limited`);
    if (res.status >= 500) throw new MarketplaceTransientError(`TikTok ${path} HTTP ${res.status}`);

    const json = await res.json().catch(() => ({}));
    // A Shop API devolve 200 com `code`/`message` mesmo em erro de negócio
    // (padrão confirmado no token/get acima; assumido igual pro resto da API
    // até confirmação em contrário).
    if (json.code && json.code !== 0) {
      if ([105002, 105003, 36004001].includes(json.code)) { // token inválido/expirado — códigos a confirmar contra erro real
        throw new MarketplaceTokenInvalidError(`TikTok ${path}: código ${json.code} — ${json.message || ''}`);
      }
      throw new Error(`TikTok ${path} -> ${json.code}: ${json.message || ''}`);
    }
    if (!res.ok) throw new Error(`TikTok ${path} -> HTTP ${res.status}`);
    return json;
  }

  // Renova o access_token via refresh_token. GET direto (mesmo padrão do
  // token/get — sem assinatura HMAC).
  async refreshAccessToken() {
    const { appKey, appSecret, refreshToken } = this.cfg;
    if (!refreshToken) throw new MarketplaceTokenInvalidError('TikTok: refresh_token ausente para esta conta');
    const qs = new URLSearchParams({ app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    const res = await fetch(`${AUTH_BASE}/api/v2/token/refresh?${qs}`);
    if (res.status === 429) throw new MarketplaceRateLimitError('TikTok token/refresh rate limited');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.code) {
      throw new MarketplaceTokenInvalidError(`TikTok refresh falhou: ${body.code || res.status} — ${body.message || ''}`);
    }
    const data = body.data || body;
    this.cfg.accessToken = data.access_token;
    this.cfg.refreshToken = data.refresh_token;
    return data; // { access_token, refresh_token, access_token_expire_in }
  }

  // orderId = order_id da TikTok Shop (string opaca).
  async getOrder(orderId) {
    this._assertConfigured();
    const detail = await this._call(`/order/${ORDER_API_VERSION}/orders/${orderId}`, { method: 'GET' });
    // ⚠️ Nome do campo de resposta a confirmar — ver aviso no topo do arquivo.
    return detail?.data?.order_list?.[0] || detail?.data || null;
  }

  // sinceISODate: filtra por pedidos atualizados desde essa data (equivalente
  // ao dateFrom do ml.searchOrders / update_time da Shopee).
  async listRecentOrders(sinceISODate) {
    this._assertConfigured();
    const updateTimeGe = Math.floor(new Date(sinceISODate).getTime() / 1000);
    // POST — /orders/search recebe o filtro no BODY (confirmado: é POST, não GET,
    // diferente da Shopee). page_size/sort_field a confirmar contra a doc real.
    const resp = await this._call(`/order/${ORDER_API_VERSION}/orders/search`, {
      method: 'POST',
      query: { page_size: '50' },
      body: { update_time_ge: updateTimeGe },
    });
    return resp?.data?.orders || resp?.data?.order_list || [];
  }
}

module.exports = { TiktokClient, getAuthorizationUrl, exchangeCodeForToken, sign, API_BASE, AUTH_BASE };
