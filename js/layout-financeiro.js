// Sidebar + topbar do MÓDULO FINANCEIRO — sistema próprio, menu lateral
// independente (mesmo molde de js/layout-shopee.js). Fonte de dados futura:
// Supabase separado (ver .claude/modules.md). Hoje só a página "em construção".
// Nunca incluído por páginas do Operacional — cada módulo tem seu próprio menu.

const FIN_NAV_ITEMS = [
  { href: 'financeiro-vendas.html', icon: 'fa-chart-line', label: 'Vendas & Custos' },
  { href: 'financeiro-despesas.html', icon: 'fa-file-invoice-dollar', label: 'Despesas & DRE' },
  { href: 'financeiro.html', icon: 'fa-database', label: 'Dados (Supabase)' },
];

// Switcher de módulos (igual ao de layout.js, replicado aqui porque este layout
// monta seu próprio topbar). Paths relativos a pages/.
function buildModuleSwitcherFin(active) {
  const mods = [
    { key: 'operacional', href: '../index.html',             icon: 'fa-gears',               label: 'Operacional' },
    { key: 'financeiro',  href: 'financeiro.html',           icon: 'fa-money-bill-trend-up', label: 'Financeiro' },
    { key: 'bi',          href: 'inteligencia-negocio.html', icon: 'fa-brain',               label: 'Inteligência de Negócio' },
  ];
  return `<nav class="module-switcher">${mods.map(m => `
    <a href="${m.href}" class="${m.key === active ? 'active' : ''}"><i class="fas ${m.icon}"></i><span>${m.label}</span></a>`).join('')}</nav>`;
}

function buildFinSidebar(activeHref) {
  const items = FIN_NAV_ITEMS.map(({ href, icon, label }) => {
    const active = href === activeHref ? 'active' : '';
    return `<a href="${href}" class="nav-item ${active}"><i class="fas ${icon}"></i><span>${label}</span></a>`;
  }).join('');
  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name" style="color:#22c55e"><i class="fas fa-money-bill-trend-up"></i> Financeiro</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <span class="nav-section-title">Financeiro</span>
          ${items}
        </div>
      </nav>
    </aside>`;
}

function buildFinTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
        ${buildModuleSwitcherFin('financeiro')}
      </div>
      <div class="topbar-right">
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildFinSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildFinTopbar(window.PAGE_TITLE || 'Financeiro');
});
