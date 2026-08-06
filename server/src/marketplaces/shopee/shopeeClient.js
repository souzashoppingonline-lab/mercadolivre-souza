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
//   partnerId, partnerKey   — app-level ou por conta. Se presentes em `cfg`, usam per-store (v46);
//                              senão caem pra global env.shopee.partnerId/partnerKey (backward compat).
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
    // partnerId/partnerKey podem vir de per-store ou global (fallback)
    const partnerId = this.cfg?.partnerId || this.cfg?.globalPartnerId;
    const partnerKey = this.cfg?.partnerKey || this.cfg?.globalPartnerKey;
    const missing = [];
    if (!partnerId) missing.push('partnerId');
    if (!partnerKey) missing.push('partnerKey');
    if (!this.cfg?.shopId) missing.push('shopId');
    if (!this.cfg?.accessToken) missing.push('accessToken');
    if (missing.length) {
      throw new MarketplaceTokenInvalidError(`Shopee não configurada para esta conta — faltando: ${missing.join(', ')}`);
    }
  }

  // Chamada shop-level assinada. Os endpoints de leitura da Shopee (order/*)
  // são GET com TODOS os parâmetros de negócio no query string (`query`) — em
  // produção um POST nesses paths retorna 404 (o sandbox tolerava POST, mas não
  // era o contrato). Só a assinatura (partner_id + api_path + timestamp +
  // access_token + shop_id) entra no `sign`; os params de `query` não.
  async _call(apiPath, { method = 'POST', body, query, useAccessToken = true } = {}) {
    // Fallback: per-store credentials (v46) or global (backward compat)
    const partnerId = this.cfg?.partnerId || this.cfg?.globalPartnerId;
    const partnerKey = this.cfg?.partnerKey || this.cfg?.globalPartnerKey;
    const { env, shopId, accessToken } = this.cfg;
    const timestamp = nowSeconds();
    const signature = sign({
      partnerId, partnerKey, apiPath, timestamp,
      accessToken: useAccessToken ? accessToken : undefined,
      shopId: useAccessToken ? shopId : undefined,
    });
    const qs = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature });
    if (useAccessToken) { qs.set('access_token', accessToken); qs.set('shop_id', String(shopId)); }
    if (query) for (const [k, v] of Object.entries(query)) { if (v != null) qs.set(k, String(v)); }

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
    const fields = ['total_amount', 'order_status', 'item_list', 'create_time', 'update_time', 'shipping_carrier'];
    if (this.cfg.sensitiveAccess) fields.unshift('buyer_username');
    // GET: order_sn_list e response_optional_fields como listas separadas por
    // vírgula no query string (não body — ver comentário em _call).
    const detail = await this._call('/api/v2/order/get_order_detail', {
      method: 'GET',
      query: {
        order_sn_list: orderId,
        response_optional_fields: fields.join(','),
      },
    });
    return detail?.response?.order_list?.[0] || null;
  }

  // sinceISODate: ISO 8601 — filtra por update_time (equivalente ao dateFrom do ml.searchOrders).
  async listRecentOrders(sinceISODate) {
    this._assertConfigured();
    const timeFrom = Math.floor(new Date(sinceISODate).getTime() / 1000);
    const timeTo = nowSeconds();
    // GET com os params no query string. A Shopee limita a janela a 15 dias —
    // o polling usa cursor curto (últimas 24h por padrão), então não estoura.
    const list = await this._call('/api/v2/order/get_order_list', {
      method: 'GET',
      query: {
        time_range_field: 'update_time',
        time_from: timeFrom,
        time_to: timeTo,
        page_size: 50,
        cursor: '',
        response_optional_fields: 'order_status',
      },
    });
    return list?.response?.order_list || [];
  }

  // Rastreio (tracking number) de um pedido — Logistics API, GET com params no
  // query. Só existe DEPOIS que o pedido é preparado pra envio (READY_TO_SHIP+);
  // antes disso a Shopee devolve erro/vazio. É o valor que está no QR da
  // etiqueta (ex.: BR269090120689K) — usado pra casar etiqueta→pedido na
  // Embalagem (ver .claude/embalagem.md).
  async getTrackingNumber(orderSn) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/logistics/get_tracking_number', {
      method: 'GET',
      query: { order_sn: orderSn },
    });
    return resp?.response?.tracking_number || null;
  }

  // Financeiro (repasse/escrow) do pedido — detalhamento de taxa + líquido.
  // `order_income.escrow_amount` = valor líquido que o vendedor recebe. Só
  // finaliza depois do pagamento confirmado. GET. Ver .claude/shopee.md.
  async getEscrowDetail(orderSn) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/payment/get_escrow_detail', {
      method: 'GET',
      query: { order_sn: orderSn },
    });
    return resp?.response || null;
  }

  // Status de entrega + eventos de rastreio. `logistics_status` é o status
  // geral (ORDER_CREATED/... /DELIVERED); `tracking_info[]` são os eventos. GET.
  async getTrackingInfo(orderSn) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/logistics/get_tracking_info', {
      method: 'GET',
      query: { order_sn: orderSn },
    });
    return resp?.response || null;
  }

  // ── Product API (catálogo) — GET, params no query string ──

  // Lista TODOS os item_id da loja no status pedido (NORMAL=ativo), paginando
  // (offset/page_size, máx 100). Retorna só os ids + status (o detalhe vem no
  // getItemsBaseInfo). Confirmado no diagnóstico test-shopee-produtos.js.
  async listAllItems(itemStatus = 'NORMAL', pageSizeMax = 100) {
    this._assertConfigured();
    const all = [];
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) { // teto de segurança (200*100 = 20k itens)
      const resp = await this._call('/api/v2/product/get_item_list', {
        method: 'GET',
        query: { offset: String(offset), page_size: String(pageSizeMax), item_status: itemStatus },
      });
      const items = resp?.response?.item || [];
      all.push(...items);
      if (!resp?.response?.has_next_page || !items.length) break;
      offset = resp.response.next_offset != null ? resp.response.next_offset : offset + items.length;
    }
    return all;
  }

  // Detalhe base de até 50 itens por chamada (item_id_list separado por vírgula).
  // Traz item_name, item_sku, category_id, item_status, description, image, e —
  // para itens SEM variação — price_info/stock_info_v2 e has_model.
  async getItemsBaseInfo(itemIdList) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/product/get_item_base_info', {
      method: 'GET',
      query: { item_id_list: itemIdList.join(',') },
    });
    return resp?.response?.item_list || [];
  }

  // Variações (models) de um item, com preço/estoque/SKU por variação —
  // fonte autoritativa de preço/estoque (price_info[].current_price,
  // stock_info_v2.summary_info.total_available_stock). Ver diagnóstico.
  async getModelList(itemId) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/product/get_model_list', {
      method: 'GET',
      query: { item_id: String(itemId) },
    });
    return resp?.response || { tier_variation: [], model: [] };
  }

  // ── Promoções (leitura) — GET, params no query string ──

  // Lista descontos (promoção de preço) do status pedido (ongoing/upcoming/
  // expired/all), paginando via `more`. Campos: discount_id, discount_name,
  // start_time, end_time (epoch s), status. Confirmado em test-shopee-promo.js.
  async getDiscountList(status = 'ongoing', pageSize = 100) {
    this._assertConfigured();
    const all = [];
    let pageNo = 1;
    for (let guard = 0; guard < 100; guard++) {
      const resp = await this._call('/api/v2/discount/get_discount_list', {
        method: 'GET',
        query: { discount_status: status, page_no: String(pageNo), page_size: String(pageSize) },
      });
      const list = resp?.response?.discount_list || [];
      all.push(...list);
      if (!resp?.response?.more || !list.length) break;
      pageNo += 1;
    }
    return all;
  }

  // Lista vouchers/cupons do status pedido, paginando via `more`. Campos:
  // voucher_id, voucher_name, voucher_code, start_time, end_time, reward_type
  // (1=valor fixo/2=%), percentage|discount_amount, min_basket_price,
  // current_usage, usage_quantity, item_id_list (voucher de produto).
  async getVoucherList(status = 'all', pageSize = 100) {
    this._assertConfigured();
    const all = [];
    let pageNo = 1;
    for (let guard = 0; guard < 100; guard++) {
      const resp = await this._call('/api/v2/voucher/get_voucher_list', {
        method: 'GET',
        query: { status, page_no: String(pageNo), page_size: String(pageSize) },
      });
      const list = resp?.response?.voucher_list || [];
      all.push(...list);
      if (!resp?.response?.more || !list.length) break;
      pageNo += 1;
    }
    return all;
  }

  // Devoluções/reembolsos recentes (Returns API). A Shopee limita a janela de
  // create_time a 15 dias, então varremos em janelas de 15d até cobrir `days`.
  // Paginação via `more`. Campos confirmados em test-shopee-returns.js.
  async listRecentReturns(days = 30) {
    this._assertConfigured();
    const all = [];
    const now = nowSeconds();
    const win = 15 * 24 * 3600;
    const start = now - days * 24 * 3600;
    let to = now;
    while (to > start) {
      const from = Math.max(start, to - win + 1);
      let pageNo = 1;
      for (let guard = 0; guard < 100; guard++) {
        const resp = await this._call('/api/v2/returns/get_return_list', {
          method: 'GET',
          query: { page_no: String(pageNo), page_size: '50', create_time_from: String(from), create_time_to: String(to) },
        });
        const list = resp?.response?.return || [];
        all.push(...list);
        if (!resp?.response?.more || !list.length) break;
        pageNo += 1;
      }
      to = from - 1;
    }
    return all;
  }

  // Detalhe de um desconto — traz os itens (item_list) dentro da promoção, com
  // preço promocional por variação. Pagina via `more`. GET.
  async getDiscountItems(discountId, pageSize = 100) {
    this._assertConfigured();
    const all = [];
    let pageNo = 1;
    let info = null;
    for (let guard = 0; guard < 100; guard++) {
      const resp = await this._call('/api/v2/discount/get_discount', {
        method: 'GET',
        query: { discount_id: String(discountId), page_no: String(pageNo), page_size: String(pageSize) },
      });
      const r = resp?.response || {};
      if (!info) info = { discount_name: r.discount_name, start_time: r.start_time, end_time: r.end_time, status: r.status };
      const list = r.item_list || [];
      all.push(...list);
      if (!r.more || !list.length) break;
      pageNo += 1;
    }
    return { info, item_list: all };
  }

  // Detalhe de um voucher — pra saber se é da loja toda ou de itens específicos.
  async getVoucher(voucherId) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/voucher/get_voucher', {
      method: 'GET',
      query: { voucher_id: String(voucherId) },
    });
    return resp?.response || null;
  }

  // ── Product API (ESCRITA) — POST com body. Altera a loja de verdade. ──

  // Atualiza o estoque de um item. stockList = [{model_id, stock}] (model_id=0
  // pra item sem variação). A Shopee v2 usa seller_stock[] (multi-armazém);
  // sem location_id = estoque único. Confirmar com test-shopee-update.js (no-op).
  async updateStock(itemId, stockList) {
    this._assertConfigured();
    const stock_list = stockList.map((s) => ({
      model_id: Number(s.model_id || 0),
      seller_stock: [{ stock: Number(s.stock) }],
    }));
    const resp = await this._call('/api/v2/product/update_stock', {
      method: 'POST',
      body: { item_id: Number(itemId), stock_list },
    });
    return resp?.response || null;
  }

  // Atualiza o preço de um item. priceList = [{model_id, price}] (model_id=0 pra
  // item sem variação). A Shopee chama de original_price (é o preço de venda).
  async updatePrice(itemId, priceList) {
    this._assertConfigured();
    const price_list = priceList.map((p) => ({
      model_id: Number(p.model_id || 0),
      original_price: Number(p.price),
    }));
    const resp = await this._call('/api/v2/product/update_price', {
      method: 'POST',
      body: { item_id: Number(itemId), price_list },
    });
    return resp?.response || null;
  }

  // Conversas de chat. type='unread' traz só as com mensagem não lida (o que
  // interessa pra "não respondidas"). GET; exige type + direction + page_size
  // (confirmado no diagnóstico test-shopee-chat.js — sem direction dá param_error).
  async getConversationList(type = 'unread', pageSize = 25) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/sellerchat/get_conversation_list', {
      method: 'GET',
      query: { type, direction: 'latest', page_size: String(pageSize) },
    });
    return resp?.response?.conversations || [];
  }

  // Histórico de mensagens de UMA conversa (pra abrir o chat e ver o fio inteiro,
  // não só a última). GET; params no query string (mesmo contrato dos outros
  // sellerchat/*). `offset` vazio na 1ª página. Retorna a lista mais recente.
  async getMessageList(conversationId, pageSize = 25, offset = '') {
    this._assertConfigured();
    const resp = await this._call('/api/v2/sellerchat/get_message_list', {
      method: 'GET',
      query: { conversation_id: String(conversationId), page_size: String(pageSize), offset: offset || undefined },
    });
    return resp?.response?.messages || [];
  }

  // Envia uma mensagem de texto ao comprador (resposta dentro da plataforma).
  // ESCRITA → POST com body (diferente dos sellerchat/* de leitura, que são GET).
  // `toId` é o user_id do comprador (campo to_id vindo do get_conversation_list).
  // Pode exigir "Acesso a dados sensíveis" aprovado no console — se não tiver, a
  // Shopee devolve erro de negócio e o _call propaga (a rota traduz pro usuário).
  async sendMessage(toId, text) {
    this._assertConfigured();
    const resp = await this._call('/api/v2/sellerchat/send_message', {
      method: 'POST',
      body: { to_id: Number(toId), message_type: 'text', content: { text: String(text) } },
    });
    return resp?.response || null;
  }
}

// Helper para rotas: constrói um ShopeeClient para UMA loja (linha de `stores`),
// renovando o access_token proativamente (margem 10min) e persistindo o novo par
// com CAS — mesma disciplina do ShopeePollingEventSource._ensureValidToken, mas
// pontual (uma chamada de rota), sem intervalo. Mantém shopeeClient.js sem
// dependência de banco: o pool é injetado pelo chamador.
//
// v46: Suporta per-store partner_id/key (se presentes em `stores`). Se NULL,
// cai pra global (envCfg.partnerId/partnerKey). Backward compatible.
async function getShopeeClientForStore(pool, storeId, envCfg) {
  const { rows } = await pool.query(
    `SELECT id, shopee_shop_id, access_token, refresh_token, token_expires_at,
            shopee_partner_id, shopee_partner_key
     FROM stores WHERE id = $1`,
    [storeId]
  );
  const store = rows[0];
  if (!store) throw new Error(`Loja Shopee ${storeId} não encontrada`);

  const client = new ShopeeClient({
    ...envCfg,
    shopId: store.shopee_shop_id,
    accessToken: store.access_token,
    refreshToken: store.refresh_token,
    // v46: per-store credentials (nullable, fallback to global)
    partnerId: store.shopee_partner_id || envCfg.partnerId,
    partnerKey: store.shopee_partner_key || envCfg.partnerKey,
    // Armazenar globals também pra fallback em _assertConfigured/métodos internos
    globalPartnerId: envCfg.partnerId,
    globalPartnerKey: envCfg.partnerKey,
  });

  const expiresAt = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
  const safetyMarginMs = 10 * 60 * 1000;
  if (Date.now() >= expiresAt - safetyMarginMs && store.refresh_token) {
    const tokens = await client.refreshAccessToken();
    const newExpiresAt = Date.now() + Number(tokens.expire_in || 14400) * 1000;
    // CAS: só grava se o refresh_token ainda for o que lemos (não sobrescreve
    // um par mais novo salvo pelo polling em paralelo).
    await pool.query(
      `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now()
       WHERE id=$1 AND refresh_token=$5`,
      [store.id, tokens.access_token, tokens.refresh_token, new Date(newExpiresAt), store.refresh_token]
    );
  }
  return client;
}

module.exports = { ShopeeClient, getAuthorizationUrl, exchangeCodeForToken, sign, baseUrl, getShopeeClientForStore };
