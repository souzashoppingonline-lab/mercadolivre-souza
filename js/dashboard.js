document.addEventListener('DOMContentLoaded', () => {
  // Date display
  const d = new Date();
  const el = document.getElementById('currentDate');
  if (el) el.textContent = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  // Demo data — swap with real API calls
  loadDashboard();
});

async function loadDashboard() {
  loadKPIs();
  renderVendasChart();
  renderPedidosChart();
  loadTopProdutos();
  loadAlertas();
}

function loadKPIs() {
  // Simulated KPIs; replace with ML_API calls in production
  const kpis = [
    { id: 'vendasHoje', value: utils.formatCurrency(3842.50) },
    { id: 'pedidosHoje', value: '24' },
    { id: 'perguntasPendentes', value: '7' },
    { id: 'alertasAtivos', value: '3' },
    { id: 'anunciosAtivos', value: '158' },
    { id: 'reputacao', value: 'Ouro' },
  ];
  kpis.forEach(k => {
    const el = document.getElementById(k.id);
    if (el) el.textContent = k.value;
  });
}

function renderVendasChart() {
  const ctx = document.getElementById('vendasChart');
  if (!ctx) return;

  const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const data = [2800, 3400, 2950, 4100, 3842, 5200, 1800];
  const prev = [2600, 3100, 2700, 3800, 3500, 4900, 1600];

  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Esta semana',
          data,
          borderColor: '#FFE600',
          backgroundColor: 'rgba(255,230,0,0.08)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#FFE600',
          pointRadius: 4,
        },
        {
          label: 'Semana anterior',
          data: prev,
          borderColor: '#888',
          backgroundColor: 'transparent',
          tension: 0.4,
          borderDash: [4, 4],
          pointRadius: 2,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#f0f0f0', font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => utils.formatCurrency(ctx.raw)
          }
        }
      },
      scales: {
        x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          ticks: { color: '#888', callback: v => 'R$' + (v/1000).toFixed(1) + 'k' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });

  // Period buttons
  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
    });
  });
}

function renderPedidosChart() {
  const ctx = document.getElementById('pedidosChart');
  if (!ctx) return;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pago', 'Enviado', 'Entregue', 'Cancelado'],
      datasets: [{
        data: [12, 5, 45, 2],
        backgroundColor: ['#2980b9', '#e67e22', '#27ae60', '#e74c3c'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#f0f0f0', font: { size: 11 }, padding: 12 }
        }
      }
    }
  });
}

function loadTopProdutos() {
  const produtos = [
    { nome: 'Fone Bluetooth XW3', vendas: 38, receita: 'R$ 7.220', status: 'active' },
    { nome: 'Carregador 65W USB-C', vendas: 29, receita: 'R$ 3.190', status: 'active' },
    { nome: 'Suporte Notebook Premium', vendas: 21, receita: 'R$ 2.940', status: 'active' },
    { nome: 'Mouse Sem Fio Pro', vendas: 17, receita: 'R$ 2.380', status: 'paused' },
    { nome: 'Cabo HDMI 4K 2m', vendas: 14, receita: 'R$ 980', status: 'active' },
  ];

  const tbody = document.getElementById('topProdutos');
  if (!tbody) return;

  tbody.innerHTML = produtos.map(p => `
    <tr>
      <td>${p.nome}</td>
      <td>${p.vendas}</td>
      <td>${p.receita}</td>
      <td><span class="badge ${p.status}">${p.status === 'active' ? 'Ativo' : 'Pausado'}</span></td>
    </tr>
  `).join('');
}

function loadAlertas() {
  const alertas = [
    { tipo: 'warning', msg: 'Fone Bluetooth XW3 — estoque crítico (2 un.)', time: '10min atrás' },
    { tipo: 'critical', msg: 'Pergunta sem resposta há mais de 24h', time: '1h atrás' },
    { tipo: 'info', msg: 'Novo pedido cancelado pelo comprador', time: '3h atrás' },
  ];

  const el = document.getElementById('alertasList');
  if (!el) return;

  el.innerHTML = alertas.map(a => `
    <div class="alert-item ${a.tipo === 'critical' ? 'critical' : a.tipo === 'info' ? 'info' : ''}">
      <i class="fas ${a.tipo === 'critical' ? 'fa-times-circle' : a.tipo === 'info' ? 'fa-info-circle' : 'fa-exclamation-triangle'}"
         style="color: ${a.tipo === 'critical' ? 'var(--red)' : a.tipo === 'info' ? 'var(--blue)' : 'var(--orange)'}"></i>
      <div style="flex:1">
        <div style="font-size:13px">${a.msg}</div>
        <div style="font-size:11px;color:var(--text-muted)">${a.time}</div>
      </div>
    </div>
  `).join('');
}
