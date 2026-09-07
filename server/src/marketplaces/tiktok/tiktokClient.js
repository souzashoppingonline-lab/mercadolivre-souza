// Cliente TikTok Shop Partner API — segue o mesmo contrato de
// server/src/marketplaces/interfaces/MarketplaceClient.js (mesmo molde de
// shopeeClient.js/amazonClient.js).
//
// Uso restrito: só deve ser chamado por um worker/adapter dedicado, nunca
// por rotas de leitura do dashboard — mesma regra de fronteira de
// mlClient.js/shopeeClient.js/amazonClient.js (ver .claude/architecture.md).
//
// ⚠️ FASE 1 — endpoints confirmados de duas formas: (1) busca web (o domínio
// partner.tiktokshop.com está bloqueado pelo proxy de saída deste ambiente,
// não foi possível ler a doc oficial direto) e (2) leitura do código-fonte
// real do SDK `ecomphp/tiktokshop-php` (pacote Composer ativo, não
// arquivado, API 202309+ — github.com/EcomPHP/tiktokshop-php), que confirmou
// URL de autorização, endpoint de shop_id/shop_cipher, path de pedidos e
// assinatura de request/webhook batendo com o já implementado aqui. Só 1
// ponto segue sem confirmação (nomes exatos dos campos da resposta de
// pedido — o SDK não expõe isso, só a request) — ver .claude/tiktok.md
// "O que falta confirmar". Nunca "adivinhar" além disso — mesma disciplina
// já usada para a Shopee.
const crypto = require('crypto');
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');
const { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError } = require('../base/errors');

const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = 'https://auth.tiktok-shops.com'; // troca de código/refresh de token — CONFIRMADO na doc oficial (Webhooks Overview + Download SDK)
// URL de AUTORIZAÇÃO de SELLER (dono da loja) — DOCUMENTADO PELA TIKTOK ("TTS
// API Overview" oficial, tabela "Authorization and token navigation"):
// ROW (resto do mundo, inclui Brasil) = services.tiktokshop.com/open/authorize;
// US = services.us.tiktokshop.com/open/authorize. Existem OUTRAS 2 entradas de
// autorização pra donos de dado diferentes — nunca usar por engano: creator
// (shop.tiktok.com/alliance) e PARTNER (partner.tiktokshop.com/open/authorize,
// US partner.us.tiktokshop.com/open/authorize) — partner é pra apps tipo
// "Partner/Developer" que autorizam MÚLTIPLOS sellers, diferente do nosso
// caso (Custom App de vendedor único). Se o app do usuário acabar sendo
// registrado como Partner (ver "Bloqueio de cadastro" em .claude/tiktok.md),
// confirmar se a entrada certa muda pra essa.
// CORREÇÃO: uma versão anterior deste arquivo usava auth.tiktok-shops.com/
// oauth/authorize (inferido do SDK de terceiro ecomphp/tiktokshop-php) — a
// doc oficial não confirma esse host pra autorização de seller; revertido.
const SELLER_AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize'; // ROW — trocar por services.us.tiktokshop.com se a loja for autorizada nos EUA
const API_VERSION = '202309'; // API versionada por data no path — mínimo exigido pelo SDK de referência; doc oficial recomenda sempre a versão mais nova disponível por endpoint (ver "TTS API versioning")

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Assinatura de request de negócio (Shop API) — DIFERENTE da assinatura de
// webhook (ver tiktokWebhook.js). HMAC-SHA256(app_secret, path + query_ordenada
// + body), hex minúsculo, enviada como parâmetro `sign` na query string.
// CONFIRMADO — via documentação pública ("Sign your API request") E via
// código-fonte do SDK `ecomphp/tiktokshop-php` (Client::prepareSignature),
// que implementa exatamente este algoritmo passo a passo.
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
// Host CONFIRMADO na doc oficial (ver SELLER_AUTHORIZE_URL acima). Params
// (`app_key`+`state`, sem `redirect_uri`) seguem como INFERÊNCIA TÉCNICA —
// vistos no SDK de terceiro pro host antigo, ainda não confirmados
// especificamente pra este host oficial (a página "Authorization overview"
// document detalharia os params exatos — ver .claude/tiktok.md "O que falta
// confirmar"). `redirectUri` no `.env` serve de conferência manual (comparar
// com o cadastrado no app).
function getAuthorizationUrl({ appKey, state }) {
  const qs = new URLSearchParams({ app_key: appKey, state: state || String(Math.floor(Math.random() * 90000) + 10000) });
  return `${SELLER_AUTHORIZE_URL}?${qs}`;
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
  return body.data || body; // { access_token, refresh_token, access_token_expire_in } — NÃO traz shop_id/shop_cipher (confirmado no SDK de referência); chamar getAuthorizedShops() logo em seguida pra descobrir a loja
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
  // `shop_cipher` só entra quando a conta já tem um (CONFIRMADO no SDK de
  // referência: rotas `/authorization/...` — como a de descobrir o
  // shop_cipher logo após o OAuth — excluem `shop_cipher` da assinatura;
  // sem essa omissão a 1ª chamada pós-callback quebraria por assinatura
  // errada, já que nesse momento a conta ainda não tem shop_cipher).
  async _call(path, { method = 'GET', body, query = {} } = {}) {
    const { appKey, appSecret, accessToken, shopCipher } = this.cfg;
    const timestamp = String(nowSeconds());
    const fullQuery = { app_key: appKey, timestamp, ...(shopCipher ? { shop_cipher: shopCipher } : {}), ...query };
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
    // (confirmado no token/get e no SDK de referência, que trata TODO erro
    // de negócio assim, não só o de token). CONFIRMADO no SDK: erro é
    // token/auth inválido quando os 3 primeiros dígitos do código são
    // '105' ou '360' (grupo de erro) — mais robusto que uma lista fixa de
    // códigos exatos, que nunca cobriria todos os casos reais.
    if (json.code && json.code !== 0) {
      const group = String(json.code).slice(0, 3);
      if (group === '105' || group === '360') {
        throw new MarketplaceTokenInvalidError(`TikTok ${path}: código ${json.code} — ${json.message || ''}`);
      }
      throw new Error(`TikTok ${path} -> ${json.code}: ${json.message || ''}`);
    }
    if (!res.ok) throw new Error(`TikTok ${path} -> HTTP ${res.status}`);
    return json;
  }

  // CONFIRMADO no SDK de referência: depois do token/get, o shop_id/
  // shop_cipher da loja autorizada NÃO vêm na resposta do token — é preciso
  // chamar este endpoint (autenticado com o access_token recém-emitido)
  // pra descobrir quais lojas foram autorizadas. Chamado 1x no callback OAuth
  // (routes/tiktokAuth.js), antes de gravar a linha em `stores`.
  async getAuthorizedShops() {
    const detail = await this._call(`/authorization/${API_VERSION}/shops`, { method: 'GET' });
    return detail?.data?.shops || detail?.shops || [];
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

  // orderId = order_id da TikTok Shop (string opaca). CONFIRMADO no SDK de
  // referência: é `GET order/{version}/orders?ids=id1,id2,...` (plural,
  // ids em lista separada por vírgula na query) — NÃO `orders/{id}` como um
  // path param (esse formato não existe na API real).
  async getOrder(orderId) {
    this._assertConfigured();
    const detail = await this._call(`/order/${API_VERSION}/orders`, { method: 'GET', query: { ids: String(orderId) } });
    // ⚠️ Nome exato da chave de lista na resposta (`order_list` vs `orders`)
    // não confirmado — o SDK de referência só expõe a chamada, não o shape
    // da resposta. Tenta as duas variantes prováveis antes de desistir.
    const list = detail?.data?.order_list || detail?.data?.orders || detail?.order_list || detail?.orders || [];
    return list[0] || null;
  }

  // sinceISODate: filtra por pedidos atualizados desde essa data (equivalente
  // ao dateFrom do ml.searchOrders / update_time da Shopee).
  async listRecentOrders(sinceISODate) {
    this._assertConfigured();
    const updateTimeGe = Math.floor(new Date(sinceISODate).getTime() / 1000);
    // POST — /orders/search recebe o filtro no BODY, e page_size/sort_field
    // na QUERY (confirmado no SDK de referência: Resource::extractParams
    // separa exatamente esses 2 pra query, o resto do filtro pro body).
    const resp = await this._call(`/order/${API_VERSION}/orders/search`, {
      method: 'POST',
      query: { page_size: '50' },
      body: { update_time_ge: updateTimeGe },
    });
    return resp?.data?.orders || resp?.data?.order_list || [];
  }
}

module.exports = { TiktokClient, getAuthorizationUrl, exchangeCodeForToken, sign, API_BASE, AUTH_BASE };
