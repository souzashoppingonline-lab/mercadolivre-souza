// Injects sidebar and topbar into pages that include this script.
// Usage: <div id="app-sidebar"></div> and <div id="app-topbar"></div>
// Set window.PAGE_TITLE and window.ACTIVE_NAV before including this file.

const NAV_ITEMS = [
  { section: 'Operação', items: [
    { href: 'anuncios.html', icon: 'fa-tag', label: 'Anúncios' },
    { href: 'pedidos.html', icon: 'fa-box', label: 'Pedidos' },
    { href: 'vendas.html', icon: 'fa-chart-line', label: 'Vendas Totais' },
    { href: 'perguntas.html', icon: 'fa-question-circle', label: 'Perguntas' },
    { href: 'mensagens.html', icon: 'fa-envelope', label: 'Mensagens' },
    { href: 'metricas.html', icon: 'fa-tachometer-alt', label: 'Métricas' },
    { href: 'clientes.html', icon: 'fa-users', label: 'Clientes' },
    { href: 'lojas.html', icon: 'fa-store', label: 'Lojas' },
  ]},
  { section: 'Análises', items: [
    { href: 'horarios.html', icon: 'fa-clock', label: 'Horários' },
    { href: 'diasemana.html', icon: 'fa-calendar-week', label: 'Dias da Semana' },
    { href: 'produtos.html', icon: 'fa-cubes', label: 'Produtos' },
    { href: 'performance.html', icon: 'fa-rocket', label: 'Performance' },
    { href: 'publicidade.html', icon: 'fa-bullhorn', label: 'Publicidade' },
    { href: 'concorrentes.html', icon: 'fa-users-slash', label: 'Concorrentes' },
  ]},
  { section: 'Comparativos', items: [
    { href: 'periodo.html', icon: 'fa-calendar-alt', label: 'Período vs Período' },
    { href: 'evolucao.html', icon: 'fa-chart-area', label: 'Evolução Diária' },
    { href: 'curvaABC.html', icon: 'fa-sort-amount-down', label: 'Curva ABC' },
  ]},
  { section: 'Alertas', items: [
    { href: 'reposicao.html', icon: 'fa-boxes', label: 'Reposição' },
    { href: 'cancelamentos.html', icon: 'fa-times-circle', label: 'Cancelamentos' },
    { href: 'devolucoes.html', icon: 'fa-undo', label: 'Devoluções' },
    { href: 'anuncios-problema.html', icon: 'fa-exclamation-triangle', label: 'Anúncios Problema' },
  ]},
  { section: 'Sistema', items: [
    { href: 'monitor.html', icon: 'fa-telegram fab', label: 'Monitor & Telegram', brand: true },
    { href: 'schedule.html', icon: 'fa-calendar-check', label: 'Schedule' },
    { href: 'webhook.html', icon: 'fa-plug', label: 'Webhooks' },
  ]},
];

function buildSidebar(activeHref) {
  const sections = NAV_ITEMS.map(({ section, items }) => `
    <div class="nav-section">
      <span class="nav-section-title">${section}</span>
      ${items.map(({ href, icon, label, brand }) => {
        const active = href === activeHref ? 'active' : '';
        const iconClass = brand ? `fab ${icon}` : `fas ${icon}`;
        return `<a href="${href}" class="nav-item ${active}"><i class="${iconClass}"></i><span>${label}</span></a>`;
      }).join('')}
    </div>
  `).join('');

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name">ML Dashboard</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">${sections}</nav>
    </aside>`;
}

function buildTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-right">
        <span id="wsStatus" style="font-size:12px;color:var(--text-muted)">
          <i class="fas fa-circle" style="color:var(--orange);font-size:8px"></i> conectando
        </span>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildTopbar(window.PAGE_TITLE || 'Dashboard');
});
