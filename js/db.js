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
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) return { error: body?.error || `HTTP ${res.status}` };
      return body;
    } catch (e) {
      console.error('[DB] GET error', path, e);
      return { error: e.message };
    }
  },

  async _patch(path, body) {
    try {
      const res = await fetch(new URL(`${this.BASE}${path}`, location.origin).toString(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }
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
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      console.error('[DB] POST error', path, e);
      return null;
    }
  },

  // Upload multipart (FormData) — sem Content-Type manual, o navegador
  // define o boundary certo sozinho. Timeout próprio (AbortController):
  // sem isso, se a rede/servidor travar no meio do upload, o fetch nunca
  // resolve e a tela fica presa pra sempre — com o timeout, cai no catch
  // e devolve null como qualquer outra falha, liberando a UI.
  async _postForm(path, formData, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.BASE}${path}`, { method: 'POST', body: formData, signal: controller.signal });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      console.error('[DB] POST(form) error', path, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  async _delete(path) {
    try {
      const res = await fetch(`${this.BASE}${path}`, { method: 'DELETE' });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      console.error('[DB] DELETE error', path, e);
      return null;
    }
  },

  // ── Dashboard ──────────────────────────────────────────────
  async getDashboardKPIs()    { return this._get('/dashboard/kpis'); },
  async getDashboardPorMarketplace() { return this._get('/dashboard/por-marketplace'); },
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
  async getProdutoDetalhe(id)          { return this._get(`/produtos/${id}/detalhe`); },
  async getVendasHoje()                { return this._get('/vendas/hoje'); },
  async getVendasHojeVsOntem(store_id='') { return this._get(`/vendas/hoje-vs-ontem${store_id ? '?store_id='+store_id : ''}`); },
  async getVendasPorLoja(params = {})  { return this._get('/vendas/por-loja', params); },
  async getMargemContribuicao(params = {}) { return this._get('/vendas/margem', params); },
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
  async excluirPergunta(id) { return this._delete(`/perguntas/${id}`); },

  // ── Mensagens ──────────────────────────────────────────────
  async getMensagens(params = {}) { return this._get('/mensagens', params); },

  // ── Clientes ───────────────────────────────────────────────
  async getClientes(params = {})  { return this._get('/clientes', params); },
  async getCliente(id)            { return this._get(`/clientes/${id}`); },

  // ── Lojas ──────────────────────────────────────────────────
  async getLojas()                { return this._get('/lojas'); },
  async getAlteracoes(days=7, store_id='') { return this._get(`/alteracoes?days=${days}&store_id=${encodeURIComponent(store_id)}`); },

  // ── Lojas — Amazon ─────────────────────────────────────────
  // Ao contrário de _post/_patch (que descartam o corpo do erro e retornam
  // null), estes preservam { error: "..." } do backend em caso de falha,
  // para exibir a mensagem exata dentro do modal em vez de um erro genérico.
  async getLojasAmazon()           { return this._get('/lojas/amazon'); },
  async addLojaAmazon(data) {
    try {
      const res = await fetch(new URL(`${this.BASE}/lojas/amazon`, location.origin).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) return { error: body?.error || `HTTP ${res.status}` };
      return body;
    } catch (e) {
      console.error('[DB] POST error', '/lojas/amazon', e);
      return { error: e.message };
    }
  },
  async deleteLojaAmazon(id) {
    try {
      const res = await fetch(new URL(`${this.BASE}/lojas/amazon/${id}`, location.origin).toString(), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) return { error: body?.error || `HTTP ${res.status}` };
      return body;
    } catch (e) {
      console.error('[DB] DELETE error', `/lojas/amazon/${id}`, e);
      return { error: e.message };
    }
  },

  // ── Dashboard Amazon (isolado — não reutiliza rotas do ML) ──
  async getAmazonKpis()     { return this._get('/amazon/kpis'); },
  async getAmazonPedidos()  { return this._get('/amazon/pedidos'); },
  async getAmazonProdutos(params = {}) { return this._get('/amazon/produtos', params); },
  async getAmazonStatus()   { return this._get('/amazon/status'); },

  // ── Dashboard Shopee (isolado — não reutiliza rotas do ML) ──
  async getShopeeKpis()     { return this._get('/shopee/kpis'); },
  async getShopeePedidos()  { return this._get('/shopee/pedidos'); },
  async getShopeeProdutos(params = {}) { return this._get('/shopee/produtos', params); },
  async getShopeeStatus()   { return this._get('/shopee/status'); },
  async getShopeeLojas()    { return this._get('/shopee/lojas'); },
  async renomearShopeeLoja(id, nickname) { return this._patch(`/shopee/lojas/${id}`, { nickname }); },
  async getShopeeEstoquePreco(params = {}) { return this._get('/shopee/estoque-preco', params); },
  async aplicarShopeeEstoquePreco(changes) { return this._post('/shopee/anuncios/aplicar', { changes }); },
  async getShopeePrecificador(params = {}) { return this._get('/shopee/precificador', params); },
  async salvarShopeeCusto(item_id, model_id, cost) { return this._post('/shopee/custo', { item_id, model_id, cost }); },
  async getShopeePromocoes(params = {}) { return this._get('/shopee/promocoes', params); },
  async getShopeePromocaoItens(tipo, promoId) { return this._get(`/shopee/promocoes/${tipo}/${encodeURIComponent(promoId)}/itens`); },
  async getShopeeProblemas(params = {}) { return this._get('/shopee/problemas', params); },
  async getShopeeDevolucoes(params = {}) { return this._get('/shopee/devolucoes', params); },
  async getShopeeExecutivo(params = {}) { return this._get('/shopee/executivo', params); },
  async getShopeePerformance(params = {}) { return this._get('/shopee/performance', params); },
  async getShopeeIaSocio(store_id) { return this._post('/shopee/ia-socio', { store_id }); },
  async getShopeeScore(params = {}) { return this._get('/shopee/score', params); },
  async getShopeeVendas(params = {})   { return this._get('/shopee/vendas', params); },
  async getShopeeAnuncios(params = {}) { return this._get('/shopee/anuncios', params); },
  async getShopeeFinanceiro(params = {}) { return this._get('/shopee/financeiro', params); },
  async getShopeeChat(params = {}) { return this._get('/shopee/chat', params); },
  async getShopeeChatMensagens(conversationId) { return this._get(`/shopee/chat/${encodeURIComponent(conversationId)}/mensagens`); },
  async responderShopeeChat(conversation_id, text) { return this._post('/shopee/chat/responder', { conversation_id, text }); },

  // ── Análise de Produtos (Fase 1 — ver .claude/analise-produtos.md) ──
  async getProdutosAnalise() { return this._get('/analise/produtos'); },
  async getProdutoAnalise(id) { return this._get(`/analise/produtos/${id}`); },
  async criarProdutoAnalise(data) { return this._post('/analise/produtos', data); },
  async editarProdutoAnalise(id, data) { return this._post(`/analise/produtos/${id}/editar`, data); },
  async ativarColetaProduto(id) { return this._post(`/analise/produtos/${id}/ativar`, {}); },
  async finalizarColetaProduto(id) { return this._post(`/analise/produtos/${id}/finalizar`, {}); },
  async analisarProduto(id) { return this._post(`/analise/produtos/${id}/analisar`, {}); },
  async addAnuncioManual(id, data) { return this._post(`/analise/produtos/${id}/anuncio`, data); },
  async editarAnuncio(adId, data) { return this._post(`/analise/anuncios/${adId}/editar`, data); },
  async excluirAnuncio(adId) { return this._post(`/analise/anuncios/${adId}/excluir`, {}); },

  // ── Horários & Dias ────────────────────────────────────────
  async getHorarios(period='7', store_id='') { return this._get(`/analises/horarios?period=${period}&store_id=${encodeURIComponent(store_id)}`); },
  async getDiasSemana(days=90)    { return this._get(`/analises/dias-semana?days=${days}`); },

  // ── Produtos ───────────────────────────────────────────────
  async getEstoqueParado(params = {})        { return this._get('/analises/estoque-parado', params); },
  async getProdutos(params = {})             { return this._get('/produtos', params); },
  async getPerformance(params={})            { return this._get('/produtos/performance', params); },
  async getProdutosPerformance(params={})    { return this._get('/produtos/performance', params); },
  async getProdutoHistoricoDiario(id, params={}) { return this._get(`/produtos/${id}/historico-diario`, params); },
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

  // ── Análise de Vendas do Mês (BI) ────────────────────────────
  async getAnaliseVendasMes(params = {}) { return this._get('/analises/vendas-mes', params); },
  async getVendasDoDia(date, store_id='') { return this._get('/analises/vendas-mes/dia', { date, store_id }); },
  async getDiaHistorico(params = {}) { return this._get('/analises/vendas-mes/dia-historico', params); },

  // ── Top Vendas Online (dashboard matinal) ────────────────────
  async getResumoOntem()       { return this._get('/dashboard/resumo-ontem'); },
  async getTopVendasDia()      { return this._get('/dashboard/top-vendas-dia'); },
  async getResumoSemanalDash() { return this._get('/dashboard/resumo-semanal'); },
  async getAlertasDia()        { return this._get('/dashboard/alertas-dia'); },

  // ── Alertas ────────────────────────────────────────────────
  async getReposicao(p={})        { return this._get(`/alertas/reposicao?threshold=${p.threshold||15}&store_id=${p.store_id||''}`); },
  async getCancelamentos(params)  { return this._get('/alertas/cancelamentos', params); },
  async getDevolucoes(params)          { return this._get('/alertas/devolucoes', params); },
  async saveDevolucaoNote(id, note)    { return this._patch(`/alertas/devolucoes/${id}/note`, { note }); },
  async saveDevolucaoPrejuizo(id, prejuizo) { return this._patch(`/alertas/devolucoes/${id}/prejuizo`, { prejuizo }); },
  async saveDevolucaoChamado(id, abertura_chamado) { return this._patch(`/alertas/devolucoes/${id}/abertura-chamado`, { abertura_chamado }); },
  async saveDevolucaoSituacao(id, situacao, label) { return this._post(`/alertas/devolucoes/${id}/situacao`, { situacao, label }); },
  async atualizarDevolucaoStatus(id) {
    // Fetch próprio (não usa _post) pra preservar a mensagem de erro do corpo
    // — inclusive o 429 amigável — em vez de virar null no catch genérico.
    try {
      const res = await fetch(`${this.BASE}/alertas/devolucoes/${id}/atualizar-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      return await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    } catch (e) { return { error: e.message }; }
  },
  async getDevolucoesEvolucao(params = {}) { return this._get('/alertas/devolucoes/evolucao', params); },
  async getAnunciosProblema(p={})  { return this._get('/alertas/anuncios-problema', p); },
  async getQualidadeAnuncio(p={})  { return this._get('/qualidade-anuncio', p); },
  async getQualidadeAnuncioHistorico(itemId, p={}) { return this._get(`/qualidade-anuncio/${itemId}/historico`, p); },
  async getQualidadeAnuncioHistoricoMedio(p={}) { return this._get('/qualidade-anuncio/historico-medio', p); },
  async getQualidadeAnuncioConcorrentes(itemId) { return this._get(`/qualidade-anuncio/${itemId}/concorrentes`); },
  async getItemPromotion(item_id, store_id) { return this._get(`/items/${item_id}/promotion`, { store_id }); },
  async syncAnunciosPerformance(body={}) {
    return fetch(`${this.BASE}/alertas/anuncios-performance/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
  },

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

  // ── E-mail (Resend) ────────────────────────────────────────
  async getEmailConfig()              { return this._get('/config/email'); },
  async saveEmailConfig(body)         { return this._patch('/config/email', body); },
  async testEmail()                   { return this._post('/config/email/test', {}); },

  // ── Schedule ───────────────────────────────────────────────
  async getScheduleJobs()              { return this._get('/schedule/jobs'); },
  async triggerJob(name)               { return this._post(`/schedule/jobs/${name}/trigger`, {}); },
  async getScheduleLogs(limit=100)     { return this._get('/schedule/logs', { limit }); },
  async getScheduleRuns(params={})     { return this._get('/schedule/runs', params); },

  // ── Agenda Trello ──────────────────────────────────────────
  async getTasks(params={})            { return this._get('/tasks', params); },
  async getTasksSummary()              { return this._get('/tasks/summary'); },
  async getSaudeSistema()              { return this._get('/sistema/saude'); },
  async createTask(body)               { return this._post('/tasks', body); },
  async updateTask(id, body)           { return this._patch(`/tasks/${id}`, body); },
  async deleteTask(id)                 { return this._delete(`/tasks/${id}`); },
  async getTaskComments(id)            { return this._get(`/tasks/${id}/comments`); },
  async addTaskComment(id, body)       { return this._post(`/tasks/${id}/comments`, body); },

  // ── Embalagem ────────────────────────────────────────────────
  async getPedidoPorEtiqueta(shippingId) { return this._get(`/embalagem/pedido/${encodeURIComponent(shippingId)}`); },
  async finalizarEmbalagem(formData)     { return this._postForm('/embalagem/finalizar', formData); },
  async getVideosEmbalagem(params={})    { return this._get('/embalagem/videos', params); },
  videoEmbalagemUrl(id)                  { return `${this.BASE}/embalagem/videos/${id}/file`; },
  async getEmbalagemPorHora(params={})   { return this._get('/embalagem/por-hora', params); },
  async getVideosPorPedidos(orderIds)    { return this._get('/embalagem/videos-por-pedidos', { order_ids: orderIds.join(',') }); },
  async getEmbalagemHistorico(params={}) { return this._get('/embalagem/historico', params); },
  async getRelatorioEmbalagem(params={}) { return this._get('/embalagem/relatorio', params); },

  // ── Conciliação Bancária ──
  async getAgendaRecebimentos(params={}) { return this._get('/conciliacao/agenda-recebimentos', params); },
  async getConciliacaoPagamentos(params={}) { return this._get('/conciliacao/pagamentos', params); },
  async getConciliacaoPagamentoDetalhe(paymentId) { return this._get(`/conciliacao/pagamentos/${paymentId}`); },
  async reprocessarPagamento(paymentId) { return this._post(`/conciliacao/pagamentos/${paymentId}/reprocessar`, {}); },
  async getResumoLojasConciliacao() { return this._get('/conciliacao/resumo-lojas'); },
  // Fase 2 — Relatórios de Liberação do Mercado Pago
  async getConciliacaoExtrato(params={}) { return this._get('/conciliacao/extrato', params); },
  async getConciliacaoSaques(params={}) { return this._get('/conciliacao/saques', params); },
  async getConciliacaoAuto(params={}) { return this._get('/conciliacao/auto', params); },
  async getConciliacaoPrazo(params={}) { return this._get('/conciliacao/prazo', params); },
};
