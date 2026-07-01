document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('currentDate');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  loadDashboard();

  document.querySelector('.btn-refresh')?.addEventListener('click', loadDashboard);

  WS.on('kpis_updated', loadKPIs);
  WS.on('order_updated', () => { loadKPIs(); renderPedidosChart(); });
  WS.on('stock_alert', () => { loadKPIs(); loadAlertas(); });
});

async function loadDashboard() {
  await Promise.all([loadKPIs(), loadAlertas(), renderVendasChart(), renderPedidosChart(), loadTopProdutos()]);
}

async function loadKPIs() {
  const data = await DB.getDashboardKPIs();
  if (!data) return;
  setText('vendasHoje', utils.formatCurrency(data.vendas_hoje ?? 0));
  setText('pedidosHoje', data.pedidos_hoje ?? 0);
  setText('perguntasPendentes', data.perguntas_pendentes ?? 0);
  setText('anunciosAtivos', data.anuncios_ativos ?? 0);
}

async function loadAlertas() {
  const data = await DB.getAlerts();
  const items = data || [];
  setText('alertasAtivos', items.length);

  const el = document.getElementById('alertasList');
  if (!el) return;
  el.innerHTML = items.length
    ? items.map(a => `
      <div class="alert-item">
        <i class="fas fa-exclamation-triangle" style="color:var(--orange)"></i>
        <div style="flex:1">
          <div style="font-size:13px">${a.title} — estoque: ${a.available_quantity} un.</div>
          <div style="font-size:11px;color:var(--text-muted)">Estoque crítico</div>
        </div>
      </div>`).join('')
    : '<div class="empty-state">Nenhum alerta de estoque</div>';
}

let vendasChartInstance = null;
async function renderVendasChart() {
  const ctx = document.getElementById('vendasChart');
  if (!ctx) return;

  const period = ctx.dataset.period ? Number(ctx.dataset.period) : 7;
  const data = await DB.getVendasDiarias(period);
  const rows = data?.rows || [];

  const labels = rows.map(r => {
    const d = new Date(r.data);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  });
  const valores = rows.map(r => Number(r.bruto) || 0);

  if (vendasChartInstance) vendasChartInstance.destroy();
  vendasChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Vendas (R$)',
        data: valores,
        borderColor: '#FFE600',
        backgroundColor: 'rgba(255,230,0,0.08)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#FFE600',
        pointRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#f0f0f0', font: { size: 12 } } },
        tooltip: { callbacks: { label: c => utils.formatCurrency(c.raw) } }
      },
      scales: {
        x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          ticks: { color: '#888', callback: v => 'R$' + (v / 1000).toFixed(1) + 'k' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });

  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      ctx.dataset.period = this.dataset.period;
      renderVendasChart();
    });
  });
}

let pedidosChartInstance = null;
async function renderPedidosChart() {
  const ctx = document.getElementById('pedidosChart');
  if (!ctx) return;

  const data = await DB.getPedidos();
  const results = data?.results || [];

  const counts = { paid: 0, shipped: 0, delivered: 0, cancelled: 0 };
  results.forEach(p => {
    const s = p.status?.toLowerCase() || '';
    if (s === 'paid') counts.paid++;
    else if (s === 'shipped') counts.shipped++;
    else if (s === 'delivered') counts.delivered++;
    else if (s === 'cancelled') counts.cancelled++;
  });

  if (pedidosChartInstance) pedidosChartInstance.destroy();
  pedidosChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pago', 'Enviado', 'Entregue', 'Cancelado'],
      datasets: [{
        data: [counts.paid, counts.shipped, counts.delivered, counts.cancelled],
        backgroundColor: ['#2980b9', '#e67e22', '#27ae60', '#e74c3c'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#f0f0f0', font: { size: 11 }, padding: 12 } }
      }
    }
  });
}

async function loadTopProdutos() {
  const tbody = document.getElementById('topProdutos');
  if (!tbody) return;

  const data = await DB.getProdutos();
  const produtos = (data?.products || []).slice(0, 5);

  tbody.innerHTML = produtos.length
    ? produtos.map(p => `
      <tr>
        <td>${p.title}</td>
        <td>${p.sold ?? 0}</td>
        <td>${utils.formatCurrency((p.price ?? 0) * (p.sold ?? 0))}</td>
        <td><span class="badge ${p.status}">${p.status === 'active' ? 'Ativo' : 'Pausado'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">Nenhum produto encontrado</td></tr>';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
