// Sidebar + topbar exclusivos das páginas Amazon (pages/dashboard-amazon.html,
// amazon-vendas.html, amazon-pedidos.html, amazon-produtos.html,
// amazon-anuncios.html). Nunca incluído por páginas ML — cada marketplace
// tem seu próprio menu lateral, independente (ver .claude/frontend.md).
// Reaproveita as classes .sidebar/.nav-item/.topbar já definidas em
// css/sidebar.css e css/style.css (só troca a lista de itens), então não
// duplica CSS — só js/layout.js (ML) não é usado aqui.

const AMAZON_NAV_ITEMS = [
  { href: 'dashboard-amazon.html', icon: 'fa-home', label: 'Dashboard' },
  { href: 'amazon-vendas.html', icon: 'fa-chart-line', label: 'Vendas Totais' },
  { href: 'amazon-pedidos.html', icon: 'fa-box', label: 'Pedidos' },
  { href: 'amazon-produtos.html', icon: 'fa-cubes', label: 'Produtos' },
  { href: 'amazon-anuncios.html', icon: 'fa-tag', label: 'Anúncios' },
];

function buildAmazonSidebar(activeHref) {
  const items = AMAZON_NAV_ITEMS.map(({ href, icon, label }) => {
    const active = href === activeHref ? 'active' : '';
    return `<a href="${href}" class="nav-item ${active}"><i class="fas ${icon}"></i><span>${label}</span></a>`;
  }).join('');

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name" style="color:#ff9900"><i class="fab fa-amazon"></i> Amazon</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <span class="nav-section-title">Amazon</span>
          ${items}
        </div>
      </nav>
    </aside>`;
}

function buildAmazonTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-right">
        <nav class="mkt-switcher-compact">
          <a href="../index.html"><i class="fas fa-shopping-bag"></i> Mercado Livre</a>
          <a href="dashboard-amazon.html" class="active"><i class="fab fa-amazon"></i> Amazon</a>
          <a href="dashboard-shopee.html"><i class="fas fa-store"></i> Shopee</a>
        </nav>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildAmazonSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildAmazonTopbar(window.PAGE_TITLE || 'Amazon');
});
