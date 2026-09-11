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
  { href: 'shopee-score.html', icon: 'fa-star-half-stroke', label: 'Score de Anúncios' },
  { href: 'shopee-precos-estoque.html', icon: 'fa-money-check-dollar', label: 'Estoque & Preço' },
  { href: 'shopee-precificador.html', icon: 'fa-calculator', label: 'Precificador' },
  { href: 'shopee-promocoes.html', icon: 'fa-bullhorn', label: 'Promoções' },
  { href: 'shopee-problemas.html', icon: 'fa-triangle-exclamation', label: 'Painel de Problemas' },
  { href: 'shopee-devolucoes.html', icon: 'fa-rotate-left', label: 'Devoluções' },
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

// Sessão de staff (login de acesso restrito) — mesmo contrato de js/layout.js
// (/auth/staff/me). Sem sessão (gate desligado, ou staffAuth não usado) fica
// null e o botão de sair simplesmente não aparece. Ver .claude/auth-staff.md.
async function fetchShopeeStaffUser() {
  try {
    const res = await fetch('/auth/staff/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function buildShopeeLogoutButton(staffUser) {
  if (!staffUser) return '';
  return `
    <span style="font-size:12px;color:var(--text-muted)" title="Logado como ${staffUser.username}">
      <i class="fas fa-user-circle"></i> ${staffUser.username}
    </span>
    <button class="btn-refresh" id="btnStaffLogout" title="Sair"><i class="fas fa-sign-out-alt"></i></button>`;
}

function buildShopeeTopbar(title, staffUser) {
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
          <a href="dashboard-tiktok.html"><i class="fab fa-tiktok"></i> TikTok Shop</a>
        </nav>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
        ${buildShopeeLogoutButton(staffUser)}
      </div>
    </header>`;
}

function initShopeeLogout() {
  document.getElementById('btnStaffLogout')?.addEventListener('click', async () => {
    try { await fetch('/auth/staff/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    window.location.href = '/pages/login.html';
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  const staffUser = await fetchShopeeStaffUser();
  if (sidebarEl) sidebarEl.outerHTML = buildShopeeSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildShopeeTopbar(window.PAGE_TITLE || 'Shopee', staffUser);
  initShopeeLogout();
});
