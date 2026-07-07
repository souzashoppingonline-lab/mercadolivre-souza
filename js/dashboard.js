const R = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0);

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('currentDate');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  loadDashboard();

  document.querySelector('.btn-refresh')?.addEventListener('click', loadDashboard);

  WS.on('kpis_updated', loadKPIs);
  WS.on('order_updated', () => { loadKPIs(); loadComparativo(); renderPedidosChart(); });
  WS.on('stock_alert', () => { loadKPIs(); loadAlertas(); });
});

async function loadDashboard() {
  await Promise.all([loadKPIs(), loadComparativo(), loadAlertas(), renderVendasChart(), renderPedidosChart(), loadTopProdutos()]);
}

async function loadKPIs() {
  const data = await DB.getDashboardKPIs();
  if (!data) return;
  setText('vendasHoje', R(data.vendas_hoje ?? 0));
  setText('pedidosHoje', data.pedidos_hoje ?? 0);
  setText('perguntasPendentes', data.perguntas_pendentes ?? 0);
  setText('anunciosAtivos', data.anuncios_ativos ?? 0);
}

function _diffBadge(pct) {
  if (pct === null || pct === undefined) return '';
  const up    = pct >= 0;
  const color = up ? 'var(--green)' : '#ff3b30';
  const icon  = up ? 'fa-arrow-up' : 'fa-arrow-down';
  const sign  = up ? '+' : '';
  return `<span style="font-size:.72rem;color:${color};font-weight:700;display:inline-flex;align-items:center;gap:3px">
    <i class="fas ${icon}" style="font-size:.6rem"></i>${sign}${pct}%
  </span>`;
}

async function loadComparativo() {
  const el = document.getElementById('comparativoHoje');
  if (!el) return;
  const data = await DB.getVendasHojeVsOntem();
  if (!data || data.error) { el.style.display = 'none'; return; }
  const { hoje, ontem, diff } = data;
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
      <div style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">
        <i class="fas fa-clock" style="margin-right:5px;color:var(--primary)"></i>
        Até <b style="color:var(--text-primary)">${hora}</b> vs ontem
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:.7rem;color:var(--text-muted)">Vendas</span>
        <span style="font-size:1rem;font-weight:800;color:var(--primary)">${R(hoje.receita)}</span>
        <span style="font-size:.75rem;color:var(--text-muted)">${R(ontem.receita)}</span>
        ${_diffBadge(diff.receita_pct)}
      </div>
      <div style="width:1px;height:28px;background:var(--border)"></div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:.7rem;color:var(--text-muted)">Pedidos</span>
        <span style="font-size:1rem;font-weight:800;color:var(--green)">${hoje.pedidos}</span>
        <span style="font-size:.75rem;color:var(--text-muted)">${ontem.pedidos} ontem</span>
        ${_diffBadge(diff.pedidos_pct)}
      </div>
    </div>`;
  el.style.display = 'block';
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
        tooltip: { callbacks: { label: c => R(c.raw) } }
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
        <td>${R((p.price ?? 0) * (p.sold ?? 0))}</td>
        <td><span class="badge ${p.status}">${p.status === 'active' ? 'Ativo' : 'Pausado'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">Nenhum produto encontrado</td></tr>';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
