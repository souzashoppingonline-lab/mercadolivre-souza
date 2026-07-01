// Injects sidebar and topbar into pages that include this script.
// Usage: <div id="app-sidebar"></div> and <div id="app-topbar"></div>
// Set window.PAGE_TITLE and window.ACTIVE_NAV before including this file.

const NAV_ITEMS = [
  { section: 'Operação', items: [
    { href: 'anuncios.html', icon: 'fa-tag', label: 'Anúncios' },
    { href: 'pedidos.html', icon: 'fa-box', label: 'Pedidos' },
    { href: 'vendas.html', icon: 'fa-chart-line', label: 'Vendas Totais' },
    { href: 'promocoes.html', icon: 'fa-tags', label: 'Promoções' },
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
        <div class="store-switcher" id="storeSwitcher">
          <button class="store-switcher-btn" id="storeSwitcherBtn" title="Trocar loja">
            <span class="store-avatar" id="storeAvatar">?</span>
            <span class="store-name" id="storeNameDisplay">Todas as lojas</span>
            <i class="fas fa-chevron-down" style="font-size:10px;opacity:.6"></i>
          </button>
          <div class="store-dropdown" id="storeDropdown" style="display:none">
            <div class="store-dropdown-item" data-id="" data-name="Todas as lojas">
              <span class="store-avatar-sm all"><i class="fas fa-store"></i></span>
              <span>Todas as lojas</span>
            </div>
          </div>
        </div>
        <span id="wsStatus" style="font-size:12px;color:var(--text-muted)">
          <i class="fas fa-circle" style="color:var(--orange);font-size:8px"></i> conectando
        </span>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

function storeInitials(name) {
  return (name || '?').replace(/[_-]/g, ' ').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

async function initStoreSwitcher() {
  const data = await DB.getLojas();
  const stores = data?.stores || [];
  if (!stores.length) return;

  const dropdown = document.getElementById('storeDropdown');
  const avatar   = document.getElementById('storeAvatar');
  const nameEl   = document.getElementById('storeNameDisplay');
  if (!dropdown) return;

  const activeId = localStorage.getItem('ml_active_store') || '';

  const extra = stores.map(s => `
    <div class="store-dropdown-item" data-id="${s.id}" data-name="${s.nickname}">
      <span class="store-avatar-sm ${s.token_valid ? 'connected' : 'disconnected'}">${storeInitials(s.nickname)}</span>
      <span style="flex:1">${s.nickname}</span>
      <i class="fas fa-circle" style="font-size:8px;color:${s.token_valid ? 'var(--green)' : 'var(--red)'}" title="${s.token_valid ? 'Conectada' : 'Token expirado'}"></i>
    </div>`).join('');
  dropdown.innerHTML = dropdown.innerHTML + extra;

  const active = stores.find(s => String(s.id) === activeId);
  if (active) {
    avatar.textContent = storeInitials(active.nickname);
    nameEl.textContent = active.nickname;
    avatar.className = 'store-avatar ' + (active.token_valid ? 'connected' : 'disconnected');
  }

  document.getElementById('storeSwitcherBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => { dropdown.style.display = 'none'; });

  dropdown.querySelectorAll('.store-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const id   = item.dataset.id;
      const name = item.dataset.name;
      localStorage.setItem('ml_active_store', id);
      nameEl.textContent = name;
      avatar.textContent = id ? storeInitials(name) : '';
      if (!id) { avatar.innerHTML = '<i class="fas fa-store" style="font-size:10px"></i>'; avatar.className = 'store-avatar all'; }
      else { avatar.className = 'store-avatar'; }
      dropdown.style.display = 'none';
      window.dispatchEvent(new CustomEvent('storeChanged', { detail: { storeId: id, storeName: name } }));
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');
  if (sidebarEl) sidebarEl.outerHTML = buildSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildTopbar(window.PAGE_TITLE || 'Dashboard');
  initStoreSwitcher();
});
