// Cliente Shopee Open Platform v2 — segue o mesmo contrato de
// server/src/marketplaces/interfaces/MarketplaceClient.js.
//
// Uso restrito: só deve ser chamado por um worker/adapter dedicado, nunca
// por rotas de leitura do dashboard — mesma regra de fronteira usada para
// mlClient.js/amazonClient.js (ver .claude/architecture.md, regra 2-3).
//
// Diferente da Amazon (refresh_token fixo, só o access_token expira), a
// Shopee ROTACIONA o refresh_token a cada renovação — por isso esta classe
// nunca persiste tokens sozinha (não conhece o banco); quem chama
// refreshAccessToken() é responsável por gravar o novo par retornado em
// `stores`, com CAS (compare-and-swap) igual ao já usado para o ML em
// routes/auth.js — evita corrida entre dois workers renovando ao mesmo
// tempo (ver .claude/decisions.md).
//
// Campos esperados em `cfg` (mesmos nomes de server/.env, sem prefixo SHOPEE_,
// + campos por conta vindos de `stores`):
//   partnerId, partnerKey   — compartilhados entre todas as contas (identificam o app)
//   env                     — sandbox | production — global (SHOPEE_ENV)
//   shopId                  — por conta (stores.shopee_shop_id, ver migration)
//   accessToken             — por conta (stores.access_token)
const crypto = require('crypto');
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError } = require('../base/errors');

const BASE_URLS = {
  production: 'https://partner.shopeemobile.com',
  sandbox: 'https://partner.uat.shopeemobile.com',
};

function baseUrl(env) {
  return BASE_URLS[env === 'production' ? 'production' : 'sandbox'];
}

// timestamp em SEGUNDOS (não milissegundos — erro comum que gera "error_sign").
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// base_string partner-level: partner_id + api_path + timestamp
// base_string shop-level:    partner_id + api_path + timestamp + access_token + shop_id
function sign({ partnerId, partnerKey, apiPath, timestamp, accessToken, shopId }) {
  let baseString = `${partnerId}${apiPath}${timestamp}`;
  if (accessToken && shopId) baseString += `${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// ── Funções partner-level (sem loja associada — usadas antes de qualquer autorização) ──

// Monta a URL para redirecionar o seller autorizar o app. `redirectUri` deve
// bater exatamente com o domínio cadastrado no console da Shopee (ver .claude/shopee.md).
function getAuthorizationUrl({ partnerId, partnerKey, env, redirectUri }) {
  const apiPath = '/api/v2/shop/auth_partner';
  const timestamp = nowSeconds();
  const signature = sign({ partnerId, partnerKey, apiPath, timestamp });
  const qs = new URLSearchParams({
    partner_id: partnerId, timestamp: String(timestamp), sign: signature, redirect: redirectUri,
  });
  return `${baseUrl(env)}${apiPath}?${qs}`;
}

// Troca o `code` (recebido no redirect_uri após o seller aprovar) por
// access_token/refresh_token. Chamada única por autorização — o resultado
// deve ser persistido pelo chamador (rota de callback).
async function exchangeCodeForToken({ partnerId, partnerKey, env, code, shopId }) {
  const apiPath = '/api/v2/auth/token/get';
  const timestamp = nowSeconds();
  const signature = sign({ partnerId, partnerKey, apiPath, timestamp });
  const qs = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature });

  const res = await fetch(`${baseUrl(env)}${apiPath}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(partnerId) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new MarketplaceTokenInvalidError(`Shopee auth/token/get falhou: ${body.error || res.status} — ${body.message || ''}`);
  }
  return body; // { access_token, refresh_token, expire_in, ... }
}

class ShopeeClient extends MarketplaceClient {
  static get id() { return 'shopee'; }

  constructor(cfg) {
    super();
    this.cfg = cfg;
  }

  _assertConfigured() {
    const missing = ['partnerId', 'partnerKey', 'shopId', 'accessToken'].filter((k) => !this.cfg?.[k]);
    if (missing.length) {
      throw new MarketplaceTokenInvalidError(`Shopee não configurada para esta conta — faltando: ${missing.join(', ')}`);
    }
  }

  // Chamada shop-level assinada. `body` vai como JSON (a Shopee aceita POST
  // com corpo de negócio mesmo com os parâmetros de auth só na query string).
  async _call(apiPath, { method = 'POST', body, useAccessToken = true } = {}) {
    const { partnerId, partnerKey, env, shopId, accessToken } = this.cfg;
    const timestamp = nowSeconds();
    const signature = sign({
      partnerId, partnerKey, apiPath, timestamp,
      accessToken: useAccessToken ? accessToken : undefined,
      shopId: useAccessToken ? shopId : undefined,
    });
    const qs = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature });
    if (useAccessToken) { qs.set('access_token', accessToken); qs.set('shop_id', String(shopId)); }

    const res = await fetch(`${baseUrl(env)}${apiPath}?${qs}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });

    if (res.status === 429) throw new MarketplaceRateLimitError(`Shopee ${apiPath} rate limited`);
    if (res.status >= 500) throw new MarketplaceTransientError(`Shopee ${apiPath} HTTP ${res.status}`);

    const json = await res.json().catch(() => ({}));
    // A Shopee retorna 200 mesmo em erro de negócio, com `error`/`message` no corpo.
    if (json.error) {
      if (json.error === 'error_auth_token' || json.error === 'error_token_expired') {
        throw new MarketplaceTokenInvalidError(`Shopee ${apiPath}: ${json.error} — ${json.message || ''}`);
      }
      throw new Error(`Shopee ${apiPath} -> ${json.error}: ${json.message || ''}`);
    }
    if (!res.ok) throw new Error(`Shopee ${apiPath} -> HTTP ${res.status}`);
    return json;
  }

  // Renova o access_token usando o refresh_token atual. Retorna o par
  // completo — a Shopee pode rotacionar o refresh_token a cada chamada, e
  // quem chama este método é responsável por persistir o valor novo
  // (nunca sobrescrever silenciosamente sem CAS — ver cabeçalho do arquivo).
  async refreshAccessToken() {
    const { partnerId, partnerKey, env, shopId, refreshToken } = this.cfg;
    if (!refreshToken) throw new MarketplaceTokenInvalidError('Shopee: refresh_token ausente para esta conta');

    const apiPath = '/api/v2/auth/access_token/get';
    const timestamp = nowSeconds();
    const signature = sign({ partnerId, partnerKey, apiPath, timestamp }); // partner-level (sem access_token/shop_id)
    const qs = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature });

    const res = await fetch(`${baseUrl(env)}${apiPath}?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(partnerId) }),
    });
    if (res.status === 429) throw new MarketplaceRateLimitError('Shopee auth/access_token/get rate limited');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new MarketplaceTokenInvalidError(`Shopee refresh falhou: ${body.error || res.status} — ${body.message || ''}`);
    }
    this.cfg.accessToken = body.access_token;
    this.cfg.refreshToken = body.refresh_token;
    return body; // { access_token, refresh_token, expire_in }
  }

  // orderId aqui é o order_sn da Shopee (string opaca, não numérica).
  async getOrder(orderId) {
    this._assertConfigured();
    // `buyer_username` é dado SENSÍVEL na Shopee: só pode ser pedido se o app
    // tiver "Acesso a dados sensíveis" aprovado (SHOPEE_SENSITIVE_ACCESS=true).
    // Sem isso, o get_order_detail pode rejeitar a chamada inteira em produção —
    // então por padrão só pedimos os campos não-sensíveis (ver .claude/shopee.md).
    const fields = ['total_amount', 'order_status', 'item_list', 'create_time', 'update_time'];
    if (this.cfg.sensitiveAccess) fields.unshift('buyer_username');
    const detail = await this._call('/api/v2/order/get_order_detail', {
      body: {
        order_sn_list: [orderId],
        response_optional_fields: fields,
      },
    });
    return detail?.response?.order_list?.[0] || null;
  }

  // sinceISODate: ISO 8601 — filtra por update_time (equivalente ao dateFrom do ml.searchOrders).
  async listRecentOrders(sinceISODate) {
    this._assertConfigured();
    const timeFrom = Math.floor(new Date(sinceISODate).getTime() / 1000);
    const timeTo = nowSeconds();
    const list = await this._call('/api/v2/order/get_order_list', {
      body: {
        time_range_field: 'update_time',
        time_from: timeFrom,
        time_to: timeTo,
        page_size: 50,
        response_optional_fields: ['order_status'],
      },
    });
    return list?.response?.order_list || [];
  }
}

module.exports = { ShopeeClient, getAuthorizationUrl, exchangeCodeForToken, sign, baseUrl };
