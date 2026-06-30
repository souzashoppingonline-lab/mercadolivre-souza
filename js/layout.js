// Injects sidebar and topbar into pages that include this script.
// Usage: <div id="app-sidebar"></div> and <div id="app-topbar"></div>
// Set window.PAGE_TITLE and window.ACTIVE_NAV before including this file.
//
// Multi-store support:
//   window.CONSOLIDATED = true  → no store selector (Dashboard, Vendas, Mensagens, Perguntas)
//   window.CONSOLIDATED = false (default) → store selector shown in topbar

const NAV_ITEMS = [
  { section: 'Operação', items: [
    { href: 'anuncios.html',   icon: 'fa-tag',            label: 'Anúncios' },
    { href: 'pedidos.html',    icon: 'fa-box',            label: 'Pedidos' },
    { href: 'vendas.html',     icon: 'fa-chart-line',     label: 'Vendas Totais',    consolidated: true },
    { href: 'perguntas.html',  icon: 'fa-question-circle',label: 'Perguntas',        consolidated: true },
    { href: 'mensagens.html',  icon: 'fa-envelope',       label: 'Mensagens',        consolidated: true },
    { href: 'metricas.html',   icon: 'fa-tachometer-alt', label: 'Métricas' },
    { href: 'clientes.html',   icon: 'fa-users',          label: 'Clientes' },
    { href: 'lojas.html',      icon: 'fa-store',          label: 'Lojas' },
  ]},
  { section: 'Análises', items: [
    { href: 'horarios.html',   icon: 'fa-clock',          label: 'Horários' },
    { href: 'diasemana.html',  icon: 'fa-calendar-week',  label: 'Dias da Semana' },
    { href: 'produtos.html',   icon: 'fa-cubes',          label: 'Produtos' },
    { href: 'performance.html',icon: 'fa-rocket',         label: 'Performance' },
    { href: 'publicidade.html',icon: 'fa-bullhorn',       label: 'Publicidade' },
    { href: 'concorrentes.html',icon:'fa-users-slash',    label: 'Concorrentes' },
  ]},
  { section: 'Comparativos', items: [
    { href: 'periodo.html',    icon: 'fa-calendar-alt',   label: 'Período vs Período' },
    { href: 'evolucao.html',   icon: 'fa-chart-area',     label: 'Evolução Diária' },
    { href: 'curvaABC.html',   icon: 'fa-sort-amount-down',label:'Curva ABC' },
  ]},
  { section: 'Alertas', items: [
    { href: 'reposicao.html',       icon: 'fa-boxes',             label: 'Reposição' },
    { href: 'cancelamentos.html',   icon: 'fa-times-circle',      label: 'Cancelamentos' },
    { href: 'devolucoes.html',      icon: 'fa-undo',              label: 'Devoluções' },
    { href: 'anuncios-problema.html',icon:'fa-exclamation-triangle',label:'Anúncios Problema' },
  ]},
  { section: 'Sistema', items: [
    { href: 'monitor.html',  icon: 'fa-telegram fab', label: 'Monitor & Telegram', brand: true },
    { href: 'schedule.html', icon: 'fa-calendar-check',label:'Schedule' },
    { href: 'webhook.html',  icon: 'fa-plug',          label: 'Webhooks' },
  ]},
];

// ── Store selector ─────────────────────────────────────────────────────────

const StoreSelector = {
  STORAGE_KEY: 'ml_active_store',

  get() {
    return localStorage.getItem(this.STORAGE_KEY) || '';
  },

  set(storeId) {
    if (storeId) {
      localStorage.setItem(this.STORAGE_KEY, storeId);
    } else {
      localStorage.removeItem(this.STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent('storeChanged', { detail: { storeId } }));
  },

  getLabel() {
    return localStorage.getItem(this.STORAGE_KEY + '_label') || 'Todas as lojas';
  },

  setLabel(label) {
    localStorage.setItem(this.STORAGE_KEY + '_label', label);
  },

  // Async: populates dropdown from /api/lojas
  async buildDropdown() {
    const current = this.get();
    const currentLabel = this.getLabel();

    let options = `<option value="" ${!current ? 'selected' : ''}>Todas as lojas</option>`;
    try {
      const data = await DB._get('/lojas');
      const stores = data?.stores || [];
      stores.forEach(s => {
        const sel = s.id == current ? 'selected' : '';
        options += `<option value="${s.id}" ${sel}>${s.nickname || 'Loja ' + s.id}</option>`;
      });
    } catch (_) {
      options += `<option value="${current}" selected>${currentLabel}</option>`;
    }

    const sel = document.getElementById('storeSelectorDropdown');
    if (sel) {
      sel.innerHTML = options;
      sel.addEventListener('change', (e) => {
        const opt = e.target.options[e.target.selectedIndex];
        StoreSelector.set(e.target.value);
        StoreSelector.setLabel(opt.text);
      });
    }
  },
};

// Expose globally so pages can use it
window.StoreSelector = StoreSelector;

// ── Sidebar builder ────────────────────────────────────────────────────────

function buildSidebar(activeHref) {
  const sections = NAV_ITEMS.map(({ section, items }) => `
    <div class="nav-section">
      <span class="nav-section-title">${section}</span>
      ${items.map(({ href, icon, label, brand, consolidated }) => {
        const active = href === activeHref ? 'active' : '';
        const iconClass = brand ? `fab ${icon}` : `fas ${icon}`;
        const badge = consolidated
          ? '<span class="nav-badge" title="Consolidado — todas as lojas">Geral</span>'
          : '';
        return `<a href="${href}" class="nav-item ${active}">
          <i class="${iconClass}"></i><span>${label}${badge}</span>
        </a>`;
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

// ── Topbar builder ─────────────────────────────────────────────────────────

function buildTopbar(title, consolidated) {
  const storeSelector = consolidated ? `
    <span class="store-badge consolidated" title="Dados de todas as lojas consolidados">
      <i class="fas fa-layer-group"></i> Todas as lojas
    </span>
  ` : `
    <div class="store-selector-wrap">
      <i class="fas fa-store" style="color:var(--text-muted);font-size:13px"></i>
      <select id="storeSelectorDropdown" class="store-selector-select">
        <option value="">Carregando lojas...</option>
      </select>
    </div>
  `;

  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-right">
        ${storeSelector}
        <span id="wsStatus" style="font-size:12px;color:var(--text-muted)">
          <i class="fas fa-circle" style="color:var(--orange);font-size:8px"></i> conectando
        </span>
        <button class="btn-refresh" id="btnRefresh"><i class="fas fa-sync-alt"></i></button>
      </div>
    </header>`;
}

// ── DOMContentLoaded ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const sidebarEl = document.getElementById('app-sidebar');
  const topbarEl  = document.getElementById('app-topbar');

  const isConsolidated = window.CONSOLIDATED === true;

  if (sidebarEl) sidebarEl.outerHTML = buildSidebar(window.ACTIVE_NAV || '');
  if (topbarEl)  topbarEl.outerHTML  = buildTopbar(window.PAGE_TITLE || 'Dashboard', isConsolidated);

  // Sidebar toggle
  const sidebar  = document.getElementById('sidebar');
  const menuBtn  = document.getElementById('menuToggle');
  const sidebarBtn = document.getElementById('sidebarToggle');
  if (menuBtn)    menuBtn.addEventListener('click',    () => sidebar?.classList.toggle('open'));
  if (sidebarBtn) sidebarBtn.addEventListener('click', () => sidebar?.classList.toggle('open'));

  // Populate store dropdown (only on non-consolidated pages)
  if (!isConsolidated) {
    StoreSelector.buildDropdown();
  }
});
