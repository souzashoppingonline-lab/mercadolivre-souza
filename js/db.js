// Data layer — reads exclusively from the internal REST API backed by PostgreSQL.
// NO direct Mercado Livre API calls here. Ever.
// Data flow: ML Webhook → Gateway → BullMQ Worker → PostgreSQL → Redis → this layer
//
// Configure the backend URL in localStorage:
//   localStorage.setItem('ml_backend_url', 'http://SEU_IP:3000/api')
//
// Multi-store: endpoints that support ?store_id= automatically
// include the active store from StoreSelector.get().
// Consolidated pages (Dashboard, Vendas, Mensagens, Perguntas)
// pass store_id='' to receive data from all stores.

const DB = {
  BASE: localStorage.getItem('ml_backend_url') || 'http://localhost:3000/api',

  // Returns the active store_id for filtered pages.
  // Returns '' (empty) to get all stores.
  _storeId() {
    return (window.StoreSelector && window.StoreSelector.get) ? window.StoreSelector.get() : '';
  },

  async _get(path, params = {}) {
    const url = new URL(`${this.BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
    });
    try {
      const res = await fetch(url.toString(), { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (e) {
      console.error('[DB] GET error', path, e.message);
      return null;
    }
  },

  async _post(path, body) {
    try {
      const res = await fetch(`${this.BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error('[DB] POST error', path, e.message);
      return null;
    }
  },

  // ── Dashboard (consolidado — todas as lojas) ────────────────────────────
  async getDashboardKPIs()           { return this._get('/dashboard/kpis'); },
  async getDashboardChart(period=7)  { return this._get('/dashboard/chart', { period }); },
  async getTopProducts(limit=10)     { return this._get('/dashboard/top-products', { limit }); },
  async getAlerts()                  { return this._get('/dashboard/alerts'); },

  // ── Anúncios (por loja) ─────────────────────────────────────────────────
  async getAnuncios(params = {})  {
    return this._get('/anuncios', { store_id: this._storeId(), ...params });
  },

  // ── Pedidos (por loja) ──────────────────────────────────────────────────
  async getPedidos(params = {}) {
    return this._get('/pedidos', { store_id: this._storeId(), ...params });
  },
  async getPedido(id) { return this._get(`/pedidos/${id}`); },

  // ── Vendas (consolidado — todas as lojas) ───────────────────────────────
  async getVendas(params = {})      { return this._get('/vendas', params); },
  async getVendasDiarias(days = 30) { return this._get('/vendas/diarias', { days }); },

  // ── Perguntas (consolidado — todas as lojas) ────────────────────────────
  async getPerguntas(params = {})        { return this._get('/perguntas', params); },
  async responderPergunta(id, text)      { return this._post(`/perguntas/${id}/responder`, { text }); },

  // ── Mensagens (consolidado — todas as lojas) ────────────────────────────
  async getMensagens(params = {})  { return this._get('/mensagens', params); },

  // ── Métricas (por loja) ─────────────────────────────────────────────────
  async getMetricas() {
    return this._get('/metricas', { store_id: this._storeId() });
  },

  // ── Clientes (por loja) ─────────────────────────────────────────────────
  async getClientes(params = {}) {
    return this._get('/clientes', { store_id: this._storeId(), ...params });
  },
  async getCliente(id) { return this._get(`/clientes/${id}`); },

  // ── Lojas ───────────────────────────────────────────────────────────────
  async getLojas() { return this._get('/lojas'); },

  // ── Horários & Dias da semana (por loja) ────────────────────────────────
  async getHorarios()   { return this._get('/analises/horarios',   { store_id: this._storeId() }); },
  async getDiasSemana() { return this._get('/analises/dias-semana',{ store_id: this._storeId() }); },

  // ── Produtos (por loja) ─────────────────────────────────────────────────
  async getProdutos(params = {}) {
    return this._get('/produtos', { store_id: this._storeId(), ...params });
  },
  async getPerformance(params = {}) {
    return this._get('/produtos/performance', { store_id: this._storeId(), ...params });
  },

  // ── Publicidade & Concorrentes (por loja) ───────────────────────────────
  async getPublicidade()         { return this._get('/publicidade',    { store_id: this._storeId() }); },
  async getConcorrentes(itemId)  { return this._get('/concorrentes',   { store_id: this._storeId(), itemId }); },

  // ── Comparativos (por loja) ─────────────────────────────────────────────
  async getPeriodoVsPeriodo(p1, p2) {
    return this._get('/comparativos/periodos', { store_id: this._storeId(), p1, p2 });
  },
  async getEvolucaoDiaria(days = 30) {
    return this._get('/comparativos/evolucao', { store_id: this._storeId(), days });
  },
  async getCurvaABC() {
    return this._get('/comparativos/curva-abc', { store_id: this._storeId() });
  },

  // ── Alertas (por loja) ──────────────────────────────────────────────────
  async getReposicao() {
    return this._get('/alertas/reposicao',        { store_id: this._storeId() });
  },
  async getCancelamentos(params = {}) {
    return this._get('/alertas/cancelamentos',    { store_id: this._storeId(), ...params });
  },
  async getDevolucoes(params = {}) {
    return this._get('/alertas/devolucoes',       { store_id: this._storeId(), ...params });
  },
  async getAnunciosProblema() {
    return this._get('/alertas/anuncios-problema',{ store_id: this._storeId() });
  },

  // ── Webhooks & Schedule ─────────────────────────────────────────────────
  async getWebhookLogs(params = {})   { return this._get('/webhooks/logs',    params); },
  async getWebhookConfig()            { return this._get('/webhooks/config'); },
  async saveWebhookConfig(body)       { return this._post('/webhooks/config', body); },
  async getScheduleJobs()             { return this._get('/schedule/jobs'); },
  async triggerJob(name)              { return this._post(`/schedule/jobs/${name}/trigger`, {}); },
};
