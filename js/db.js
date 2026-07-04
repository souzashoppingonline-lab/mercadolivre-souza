// Data layer — reads exclusively from the internal REST API backed by PostgreSQL.
// NO direct Mercado Livre API calls allowed here.
// Data flow: ML Webhook → Gateway → BullMQ Worker → PostgreSQL → Redis → this layer
//
// Configure the backend URL in localStorage: ml_backend_url
const DB = {
  BASE: localStorage.getItem('ml_backend_url') || '/api',

  async _get(path, params = {}) {
    const url = new URL(`${this.BASE}${path}`, location.origin);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (e) {
      console.error('[DB] GET error', path, e);
      return null;
    }
  },

  async _patch(path, body) {
    try {
      const res = await fetch(new URL(`${this.BASE}${path}`, location.origin).toString(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error('[DB] PATCH error', path, e);
      return null;
    }
  },

  async _post(path, body) {
    try {
      const res = await fetch(`${this.BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error('[DB] POST error', path, e);
      return null;
    }
  },

  // ── Dashboard ──────────────────────────────────────────────
  async getDashboardKPIs()    { return this._get('/dashboard/kpis'); },
  async getDashboardChart(period = 7) { return this._get('/dashboard/chart', { period }); },
  async getTopProducts(limit = 10)    { return this._get('/dashboard/top-products', { limit }); },
  async getAlerts()           { return this._get('/dashboard/alerts'); },

  // ── Anúncios ───────────────────────────────────────────────
  async getAnuncios(params = {})  { return this._get('/anuncios', params); },
  async getAnuncio(id)            { return this._get(`/anuncios/${id}`); },

  // ── Pedidos ────────────────────────────────────────────────
  async getPedidos(params = {})   { return this._get('/pedidos', params); },
  async getPedido(id)             { return this._get(`/pedidos/${id}`); },

  // ── Vendas ─────────────────────────────────────────────────
  async getVendas(params = {})         { return this._get('/vendas', params); },
  async getVendasDiarias(days=30)      { return this._get('/vendas/diarias', { days }); },
  async getVendasDetalhado(params={})  { return this._get('/vendas/detalhado', params); },
  async getVendasHoje()                { return this._get('/vendas/hoje'); },
  async getVendasPorLoja(params = {})  { return this._get('/vendas/por-loja', params); },
  async updateLojaConfig(id, body)     { return this._patch(`/lojas/${id}`, body); },
  async updateLojaCredentials(id, ml_client_id, ml_client_secret) { return this._patch(`/lojas/${id}/credentials`, { ml_client_id, ml_client_secret }); },
  async updateItemCusto(id, cost)      { return this._patch(`/items/${id}/custo`, { cost }); },
  async getPedidoDetalhes(id)          { return this._get(`/pedidos/${id}/detalhes`); },
  async getSkuCost(sku)                { return this._get(`/custos/${sku}`); },
  async saveSkuCost(sku, cost)         { return this._patch(`/custos/${sku}`, { cost }); },
  async saveFreteVendedor(orderId, cost) { return this._patch(`/pedidos/${orderId}/frete-vendedor`, { cost }); },

  // ── Perguntas ──────────────────────────────────────────────
  async getPerguntas(params = {}) { return this._get('/perguntas', params); },
  async responderPergunta(id, text) { return this._post(`/perguntas/${id}/responder`, { text }); },

  // ── Mensagens ──────────────────────────────────────────────
  async getMensagens(params = {}) { return this._get('/mensagens', params); },

  // ── Métricas ───────────────────────────────────────────────
  async getMetricas()             { return this._get('/metricas'); },

  // ── Clientes ───────────────────────────────────────────────
  async getClientes(params = {})  { return this._get('/clientes', params); },
  async getCliente(id)            { return this._get(`/clientes/${id}`); },

  // ── Lojas ──────────────────────────────────────────────────
  async getLojas()                { return this._get('/lojas'); },
  async getAlteracoes(days=7, store_id='') { return this._get(`/alteracoes?days=${days}&store_id=${encodeURIComponent(store_id)}`); },

  // ── Horários & Dias ────────────────────────────────────────
  async getHorarios(period='7', store_id='') { return this._get(`/analises/horarios?period=${period}&store_id=${encodeURIComponent(store_id)}`); },
  async getDiasSemana(days=90)    { return this._get(`/analises/dias-semana?days=${days}`); },

  // ── Produtos ───────────────────────────────────────────────
  async getEstoqueParado(params = {})        { return this._get('/analises/estoque-parado', params); },
  async getProdutos(params = {})             { return this._get('/produtos', params); },
  async getPerformance(params={})            { return this._get('/produtos/performance', params); },
  async getProdutosPerformance(params={})    { return this._get('/produtos/performance', params); },
  async getVisitasAnuncio(id, days=30) { return this._get(`/anuncios/${id}/visitas`, { days }); },

  // ── Vendas ML Turbo (fonte financeira oficial) ─────────────
  async getTurboKpis(params={})      { return this._get('/turbo/kpis', params); },
  async getTurboSales(params={})     { return this._get('/turbo/sales', params); },
  async getTurboCharts(params={})    { return this._get('/turbo/charts', params); },
  async getTurboFiltersMeta()        { return this._get('/turbo/filters-meta'); },

  // ── Publicidade & Concorrentes ─────────────────────────────
  async getPublicidade()          { return this._get('/publicidade'); },
  async getConcorrentes(itemId)   { return this._get('/concorrentes', { itemId }); },

  // ── Comparativos ───────────────────────────────────────────
  async getPeriodoVsPeriodo(p1, p2) { return this._get('/comparativos/periodos', { p1, p2 }); },
  async getEvolucaoDiaria(days=30)  { return this._get('/comparativos/evolucao', { days }); },
  async getCurvaABC(params = {})    { return this._get('/comparativos/curva-abc', params); },

  // ── Alertas ────────────────────────────────────────────────
  async getReposicao(p={})        { return this._get(`/alertas/reposicao?threshold=${p.threshold||15}&store_id=${p.store_id||''}`); },
  async getCancelamentos(params)  { return this._get('/alertas/cancelamentos', params); },
  async getDevolucoes(params)          { return this._get('/alertas/devolucoes', params); },
  async saveDevolucaoNote(id, note)    { return this._patch(`/alertas/devolucoes/${id}/note`, { note }); },
  async getAnunciosProblema()     { return this._get('/alertas/anuncios-problema'); },

  // ── Webhooks ───────────────────────────────────────────────
  async getWebhookLogs(params={}) { return this._get('/webhooks/logs', params); },
  async getWebhookConfig()        { return this._get('/webhooks/config'); },
  async saveWebhookConfig(body)   { return this._post('/webhooks/config', body); },

  // ── Promoções ──────────────────────────────────────────────
  async getPromocoes(params={})          { return this._get('/promocoes', params); },

  // ── Config Telegram ────────────────────────────────────────
  async getTelegramConfig()           { return this._get('/config/telegram'); },
  async saveTelegramConfig(body)      { return this._patch('/config/telegram', body); },
  async testTelegram(message)         { return this._post('/config/telegram/test', { message }); },

  // ── Schedule ───────────────────────────────────────────────
  async getScheduleJobs()         { return this._get('/schedule/jobs'); },
  async triggerJob(name)          { return this._post(`/schedule/jobs/${name}/trigger`, {}); },
  async getScheduleLogs(limit=100){ return this._get('/schedule/logs', { limit }); },
};
