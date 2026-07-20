// Sidebar + topbar exclusivos das páginas Shopee (hoje só
// pages/dashboard-shopee.html — páginas de detalhe tipo shopee-vendas.html/
// shopee-pedidos.html/shopee-produtos.html, mesmo padrão da Amazon, ficam
// pra quando pedidos reais de sandbox começarem a chegar, ver .claude/todo.md).
// Nunca incluído por páginas ML — cada marketplace tem seu próprio menu
// lateral, independente (ver .claude/frontend.md). Reaproveita as classes
// .sidebar/.nav-item/.topbar já definidas em css/sidebar.css e css/style.css
// (só troca a lista de itens), mesmo molde de js/layout-amazon.js.

const SHOPEE_NAV_ITEMS = [
  { href: 'dashboard-shopee.html', icon: 'fa-home', label: 'Dashboard' },
  { href: 'shopee-vendas.html', icon: 'fa-chart-line', label: 'Vendas Totais' },
  { href: 'shopee-anuncios.html', icon: 'fa-tags', label: 'Anúncios' },
  { href: 'shopee-precos-estoque.html', icon: 'fa-money-check-dollar', label: 'Estoque & Preço' },
  { href: 'shopee-precificador.html', icon: 'fa-calculator', label: 'Precificador' },
  { href: 'shopee-promocoes.html', icon: 'fa-bullhorn', label: 'Promoções' },
  { href: 'shopee-problemas.html', icon: 'fa-triangle-exclamation', label: 'Painel de Problemas' },
  { href: 'shopee-performance.html', icon: 'fa-ranking-star', label: 'Performance' },
  { href: 'shopee-ia-socio.html', icon: 'fa-user-tie', label: 'IA Sócio' },
  { href: 'shopee-financeiro.html', icon: 'fa-money-bill-wave', label: 'Financeiro' },
  { href: 'shopee-chat.html', icon: 'fa-comments', label: 'Mensagens' },
  { href: 'shopee-lojas.html', icon: 'fa-store', label: 'Lojas' },
];

function buildShopeeSidebar(activeHref) {
  const items = SHOPEE_NAV_ITEMS.map(({ href, icon, label }) => {
    const active = href === activeHref ? 'active' : '';
    return `<a href="${href}" class="nav-item ${active}"><i class="fas ${icon}"></i><span>${label}</span></a>`;
  }).join('');

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name" style="color:#ee4d2d"><i class="fas fa-store"></i> Shopee</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <span class="nav-section-title">Shopee</span>
          ${items}
        </div>
      </nav>
    </aside>`;
}

function buildShopeeTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-right">
        <nav class="mkt-switcher-compact">
          <a href="../index.html"><i class="fas fa-shopping-bag"></i> Mercado Livre</a>
          <a href="dashboard-amazon.html"><i class="fab fa-amazon"></i> Amazon</a>
          <a href="dashboard-shopee.html" class="active"><i class="fas fa-store"></i> Shopee</a>
        </nav>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildShopeeSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildShopeeTopbar(window.PAGE_TITLE || 'Shopee');
});
