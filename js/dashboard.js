// Dashboard — reads from the internal REST API (/api/) and updates via WebSocket.
// No direct calls to the Mercado Livre API are made here.
document.addEventListener('DOMContentLoaded', () => {
  const d = new Date();
  const el = document.getElementById('currentDate');
  if (el) {
    el.textContent = d.toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  loadAll();

  // Live updates via WebSocket
  WS.on('kpis_updated',   loadKPIs);
  WS.on('order_updated',  loadKPIs);
  WS.on('stock_alert',    loadAlertas);
  WS.on('anuncio_updated', loadKPIs);
  WS.on('question_received', loadKPIs);
  WS.on('_connected', () => {
    const wsEl = document.getElementById('wsStatus');
    if (wsEl) wsEl.innerHTML =
      '<i class="fas fa-circle" style="color:var(--green);font-size:8px"></i> ao vivo';
  });

  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      loadVendasChart(Number(this.dataset.period) || 7);
    });
  });

  const refresh = document.querySelector('.btn-refresh');
  if (refresh) refresh.addEventListener('click', loadAll);
});

async function loadAll() {
  await Promise.all([loadKPIs(), loadVendasChart(7), loadPedidosChart(), loadTopProdutos(), loadAlertas()]);
}

async function loadKPIs() {
  const data = await DB.getDashboardKPIs() || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('vendasHoje',         utils.formatCurrency(data.vendas_hoje));
  set('pedidosHoje',        data.pedidos_hoje ?? '0');
  set('perguntasPendentes', data.perguntas_pendentes ?? '0');
  set('alertasAtivos',      data.alertas_ativos ?? '0');
  set('anunciosAtivos',     data.anuncios_ativos ?? '0');
}

let vendasChartInstance;
async function loadVendasChart(period = 7) {
  const ctx = document.getElementById('vendasChart');
  if (!ctx) return;

  const data = await DB.getDashboardChart(period) || { rows: [] };
  const rows = data.rows || [];

  if (vendasChartInstance) vendasChartInstance.destroy();

  vendasChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => r.data),
      datasets: [
        {
          label: 'Receita Bruta',
          data: rows.map(r => r.bruto),
          borderColor: '#FFE600',
          backgroundColor: 'rgba(255,230,0,0.08)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#FFE600',
          pointRadius: 4,
        },
        {
          label: 'Receita Líquida',
          data: rows.map(r => r.liquido),
          borderColor: '#27ae60',
          backgroundColor: 'transparent',
          tension: 0.4,
          borderDash: [4, 4],
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#f0f0f0', font: { size: 12 } } },
        tooltip: { callbacks: { label: c => utils.formatCurrency(c.raw) } },
      },
      scales: {
        x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          ticks: { color: '#888', callback: v => 'R$' + (v / 1000).toFixed(1) + 'k' },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
}

let pedidosChartInstance;
async function loadPedidosChart() {
  const ctx = document.getElementById('pedidosChart');
  if (!ctx) return;

  const data = await DB.getPedidos() || { results: [] };
  const rows = data.results || [];

  const counts = { paid: 0, shipped: 0, delivered: 0, cancelled: 0 };
  rows.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });

  if (pedidosChartInstance) pedidosChartInstance.destroy();

  pedidosChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pago', 'Enviado', 'Entregue', 'Cancelado'],
      datasets: [{
        data: [counts.paid, counts.shipped, counts.delivered, counts.cancelled],
        backgroundColor: ['#2980b9', '#e67e22', '#27ae60', '#e74c3c'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#f0f0f0', font: { size: 11 }, padding: 12 },
        },
      },
    },
  });
}

async function loadTopProdutos() {
  const data = await DB.getTopProducts(5) || { products: [] };
  const tbody = document.getElementById('topProdutos');
  if (!tbody) return;

  const rows = data.products || [];
  tbody.innerHTML = rows.length
    ? rows.map(p => `
        <tr>
          <td>${p.title || '—'}</td>
          <td>${p.sold || p.sold_quantity || 0}</td>
          <td>${utils.formatCurrency(p.revenue || (p.price * (p.sold || p.sold_quantity || 0)))}</td>
          <td><span class="badge ${p.status}">${p.status === 'active' ? 'Ativo' : 'Pausado'}</span></td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">Sem dados</td></tr>';
}

async function loadAlertas() {
  const rows = await DB.getAlerts() || [];
  const el = document.getElementById('alertasList');
  if (!el) return;

  el.innerHTML = rows.length
    ? rows.map(a => `
        <div class="alert-item">
          <i class="fas fa-exclamation-triangle" style="color:var(--orange)"></i>
          <div style="flex:1">
            <div style="font-size:13px">${a.title} — estoque crítico (${a.available_quantity} un.)</div>
          </div>
        </div>`).join('')
    : '<div class="empty-state">Nenhum alerta</div>';
}
