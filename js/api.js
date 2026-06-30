const ML_API = {
  BASE: 'https://api.mercadolibre.com',
  token: localStorage.getItem('ml_token') || '',

  setToken(token) {
    this.token = token;
    localStorage.setItem('ml_token', token);
  },

  headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  },

  async get(endpoint) {
    try {
      const res = await fetch(`${this.BASE}${endpoint}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error('API GET error:', endpoint, e);
      return null;
    }
  },

  async post(endpoint, body) {
    try {
      const res = await fetch(`${this.BASE}${endpoint}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error('API POST error:', endpoint, e);
      return null;
    }
  },

  // User
  async getMe() { return this.get('/users/me'); },

  // Orders
  async getOrders(userId, status = 'paid', dateFrom = null, dateTo = null) {
    let q = `/orders/search?seller=${userId}&order.status=${status}&sort=date_desc`;
    if (dateFrom) q += `&order.date_created.from=${dateFrom}`;
    if (dateTo) q += `&order.date_created.to=${dateTo}`;
    return this.get(q);
  },

  // Items
  async getItems(userId, status = 'active', offset = 0, limit = 50) {
    return this.get(`/users/${userId}/items/search?status=${status}&offset=${offset}&limit=${limit}`);
  },
  async getItem(itemId) { return this.get(`/items/${itemId}`); },
  async getItemsDetails(ids) {
    if (!ids.length) return [];
    return this.get(`/items?ids=${ids.join(',')}`);
  },

  // Questions
  async getQuestions(userId, status = 'UNANSWERED') {
    return this.get(`/questions/search?seller_id=${userId}&status=${status}&sort_fields=date_created&sort_types=DESC`);
  },

  // Messages
  async getMessages(packId) { return this.get(`/messages/packs/${packId}/sellers/me`); },

  // Metrics
  async getMetrics(userId) { return this.get(`/users/${userId}/seller_reputation`); },

  // Visits
  async getVisits(itemId, dateFrom, dateTo) {
    return this.get(`/items/${itemId}/visits/time_window?last=7&unit=day&ending=${dateTo}`);
  },

  // Billing
  async getBilling(userId, dateFrom, dateTo) {
    return this.get(`/billing/integration/periods?user_id=${userId}&date_from=${dateFrom}&date_to=${dateTo}`);
  },

  // Webhook subscriptions
  async getSubscriptions(userId) { return this.get(`/applications/me/subscriptions`); },
  async createSubscription(body) { return this.post('/applications/me/subscriptions', body); },

  // Trends
  async getTrends(siteId = 'MLB') { return this.get(`/trends/${siteId}`); },

  // Categories
  async getCategory(catId) { return this.get(`/categories/${catId}`); },

  // Shipping
  async getShipment(shipId) { return this.get(`/shipments/${shipId}`); },
};

// Utility functions
const utils = {
  formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
  },
  formatDate(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('pt-BR');
  },
  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('pt-BR');
  },
  relativeTime(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}min atrás`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h atrás`;
    return `${Math.floor(hrs / 24)}d atrás`;
  },
  groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = typeof key === 'function' ? key(item) : item[key];
      (acc[k] = acc[k] || []).push(item);
      return acc;
    }, {});
  },
  sumBy(arr, key) {
    return arr.reduce((s, i) => s + (Number(typeof key === 'function' ? key(i) : i[key]) || 0), 0);
  },
  getDateRange(days) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    return {
      from: from.toISOString().split('T')[0] + 'T00:00:00.000-03:00',
      to: to.toISOString().split('T')[0] + 'T23:59:59.000-03:00'
    };
  }
};
