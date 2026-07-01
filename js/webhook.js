// Webhook dashboard logic — shows live incoming webhooks and config status.
// Reads from /api/webhooks/logs and /api/webhooks/config.
// Real-time updates via WS topic 'webhook_received'.

const WebhookPage = {
  logs: [],
  maxLogs: 200,

  async init() {
    await this.loadConfig();
    await this.loadLogs();
    this.bindFilters();
    WS.on('webhook_received', (payload) => this.onWebhookReceived(payload));
  },

  async loadConfig() {
    try {
      const data = await DB.getWebhookConfig();
      document.getElementById('wh-received').textContent = data.received_today ?? '—';
      document.getElementById('wh-processed').textContent = data.processed_today ?? '—';
      document.getElementById('wh-failed').textContent = data.failed_today ?? '—';
      document.getElementById('wh-queue').textContent = data.queue_size ?? '—';
      const tgBadge = document.getElementById('wh-telegram');
      if (tgBadge) {
        tgBadge.textContent = data.telegram_connected ? 'Conectado' : 'Não configurado';
        tgBadge.className = 'badge ' + (data.telegram_connected ? 'badge-success' : 'badge-warning');
      }
    } catch (e) {
      console.error('[webhook] loadConfig error', e);
    }
  },

  async loadLogs() {
    const topic = document.getElementById('filter-topic')?.value || '';
    try {
      const data = await DB.getWebhookLogs({ topic, limit: 100 });
      this.logs = data.logs || [];
      this.render();
    } catch (e) {
      console.error('[webhook] loadLogs error', e);
    }
  },

  onWebhookReceived(payload) {
    this.logs.unshift(payload);
    if (this.logs.length > this.maxLogs) this.logs.pop();
    this.render();
    // Flash the counter
    const el = document.getElementById('wh-received');
    if (el) {
      const prev = Number(el.textContent) || 0;
      el.textContent = prev + 1;
    }
  },

  render() {
    const tbody = document.getElementById('webhook-logs-tbody');
    if (!tbody) return;
    const filterTopic = document.getElementById('filter-topic')?.value || '';
    const filterStatus = document.getElementById('filter-status')?.value || '';
    const rows = this.logs.filter(l =>
      (!filterTopic || l.topic === filterTopic) &&
      (!filterStatus || l.status === filterStatus)
    );
    tbody.innerHTML = rows.length
      ? rows.map(l => `
        <tr>
          <td><span class="badge ${this.topicBadge(l.topic)}">${l.topic}</span></td>
          <td class="mono">${l.resource || '—'}</td>
          <td>${l.store_id || '—'}</td>
          <td><span class="badge ${this.statusBadge(l.status)}">${l.status}</span></td>
          <td>${this.formatDate(l.received_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;opacity:.5">Nenhum webhook registrado</td></tr>';
  },

  bindFilters() {
    document.getElementById('filter-topic')?.addEventListener('change', () => this.loadLogs());
    document.getElementById('filter-status')?.addEventListener('change', () => this.loadLogs());
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      this.loadConfig();
      this.loadLogs();
    });
  },

  topicBadge(topic) {
    const map = { orders_v2: 'badge-info', payments: 'badge-success', questions: 'badge-warning', messages: 'badge-info', items: 'badge-primary' };
    return map[topic] || 'badge-secondary';
  },

  statusBadge(status) {
    return status === 'processed' ? 'badge-success' : status === 'failed' ? 'badge-danger' : 'badge-warning';
  },

  formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
};

document.addEventListener('DOMContentLoaded', () => WebhookPage.init());
