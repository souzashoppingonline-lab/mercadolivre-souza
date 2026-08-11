// Sidebar + topbar do MÓDULO INTELIGÊNCIA DE NEGÓCIO — sistema próprio, menu
// lateral independente (mesmo molde de js/layout-financeiro.js). Hoje só a
// página "em construção". Ver .claude/modules.md.

const BI_NAV_ITEMS = [
  { href: 'inteligencia-negocio.html', icon: 'fa-chart-pie', label: 'Painel Estratégico' },
];

function buildModuleSwitcherBi(active) {
  const mods = [
    { key: 'operacional', href: '../index.html',             icon: 'fa-gears',               label: 'Operacional' },
    { key: 'financeiro',  href: 'financeiro.html',           icon: 'fa-money-bill-trend-up', label: 'Financeiro' },
    { key: 'bi',          href: 'inteligencia-negocio.html', icon: 'fa-brain',               label: 'Inteligência de Negócio' },
  ];
  return `<nav class="module-switcher">${mods.map(m => `
    <a href="${m.href}" class="${m.key === active ? 'active' : ''}"><i class="fas ${m.icon}"></i><span>${m.label}</span></a>`).join('')}</nav>`;
}

function buildBiSidebar(activeHref) {
  const items = BI_NAV_ITEMS.map(({ href, icon, label }) => {
    const active = href === activeHref ? 'active' : '';
    return `<a href="${href}" class="nav-item ${active}"><i class="fas ${icon}"></i><span>${label}</span></a>`;
  }).join('');
  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name" style="color:#8b5cf6"><i class="fas fa-brain"></i> Inteligência</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <span class="nav-section-title">Inteligência de Negócio</span>
          ${items}
        </div>
      </nav>
    </aside>`;
}

function buildBiTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
        ${buildModuleSwitcherBi('bi')}
      </div>
      <div class="topbar-right">
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildBiSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildBiTopbar(window.PAGE_TITLE || 'Inteligência de Negócio');
});
