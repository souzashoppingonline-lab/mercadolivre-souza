// Sidebar + topbar exclusivos das páginas TikTok Shop: dashboard-tiktok.html
// (Fase 1: só vendas, ver .claude/tiktok.md), tiktok-vendas.html (Vendas
// Totais, dados reais via /api/tiktok/vendas) e tiktok-anuncios.html
// (Anúncios — catálogo ainda não sincronizado, vem vazio com nota). Nunca
// incluído por páginas ML — cada marketplace tem seu próprio menu lateral,
// independente (ver .claude/frontend.md). Reaproveita as classes
// .sidebar/.nav-item/.topbar já definidas em css/sidebar.css e css/style.css
// (só troca a lista de itens), mesmo molde de js/layout-shopee.js.

const TIKTOK_NAV_ITEMS = [
  { href: 'dashboard-tiktok.html', icon: 'fa-home', label: 'Dashboard' },
  { href: 'tiktok-vendas.html', icon: 'fa-dollar-sign', label: 'Vendas Totais' },
  { href: 'tiktok-anuncios.html', icon: 'fa-tags', label: 'Anúncios' },
];

function buildTiktokSidebar(activeHref) {
  const items = TIKTOK_NAV_ITEMS.map(({ href, icon, label }) => {
    const active = href === activeHref ? 'active' : '';
    return `<a href="${href}" class="nav-item ${active}"><i class="fas ${icon}"></i><span>${label}</span></a>`;
  }).join('');

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 class="brand-name" style="color:#ff0050"><i class="fab fa-tiktok"></i> TikTok Shop</h2>
        <button class="sidebar-toggle" id="sidebarToggle"><i class="fas fa-bars"></i></button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <span class="nav-section-title">TikTok Shop</span>
          ${items}
        </div>
      </nav>
    </aside>`;
}

function buildTiktokTopbar(title) {
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
          <a href="dashboard-shopee.html"><i class="fas fa-store"></i> Shopee</a>
          <a href="dashboard-tiktok.html" class="active"><i class="fab fa-tiktok"></i> TikTok Shop</a>
        </nav>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildTiktokSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildTiktokTopbar(window.PAGE_TITLE || 'TikTok Shop');
});
