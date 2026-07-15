// Injects sidebar and topbar into pages that include this script.
// Usage: <div id="app-sidebar"></div> and <div id="app-topbar"></div>
// Set window.PAGE_TITLE and window.ACTIVE_NAV before including this file.

const NAV_ITEMS = [
  { section: 'Início', items: [
    { href: '../index.html', icon: 'fa-home', label: 'Dashboard' },
    { href: 'top-vendas-online.html', icon: 'fa-bolt', label: 'Top Vendas Online' },
    { href: 'agenda-trello.html', icon: 'fa-clipboard-list', label: 'Agenda Trello' },
  ]},
  { section: 'Operação', items: [
    { href: 'anuncios.html', icon: 'fa-tag', label: 'Anúncios' },
    { href: 'pedidos.html', icon: 'fa-box', label: 'Pedidos' },
    { href: 'embalagem.html', icon: 'fa-barcode', label: 'Embalagem' },
    { href: 'vendas.html', icon: 'fa-chart-line', label: 'Vendas Totais' },
    { href: 'vendas-por-loja.html', icon: 'fa-store', label: 'Vendas por Loja' },
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
    { href: 'estoque-parado.html', icon: 'fa-box-open', label: 'Estoque Parado' },
    { href: 'publicidade.html', icon: 'fa-bullhorn', label: 'Publicidade' },
    { href: 'concorrentes.html', icon: 'fa-users-slash', label: 'Concorrentes' },
  ]},
  { section: 'Comparativos', items: [
    { href: 'periodo.html', icon: 'fa-calendar-alt', label: 'Período vs Período' },
    { href: 'evolucao.html', icon: 'fa-chart-area', label: 'Evolução Diária' },
    { href: 'curvaABC.html', icon: 'fa-sort-amount-down', label: 'Curva ABC' },
    { href: 'analise-vendas-mes.html', icon: 'fa-chart-column', label: 'Análise de Vendas do Mês' },
  ]},
  { section: 'Alertas', items: [
    { href: 'reposicao.html', icon: 'fa-boxes', label: 'Reposição' },
    { href: 'cancelamentos.html', icon: 'fa-times-circle', label: 'Cancelamentos' },
    { href: 'devolucoes.html', icon: 'fa-undo', label: 'Devoluções' },
    { href: 'anuncios-problema.html', icon: 'fa-exclamation-triangle', label: 'Anúncios Problema' },
    { href: 'alteracoes.html', icon: 'fa-history', label: 'Alterações' },
  ]},
  { section: 'Financeiro', items: [
    { href: 'vendas-turbo.html', icon: 'fa-file-excel', label: 'Vendas ML Turbo' },
  ]},
  { section: 'Sistema', items: [
    { href: 'mcp.html', icon: 'fa-robot', label: 'MCP Mercado Livre' },
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

// Alternador de marketplace (Mercado Livre/Amazon/Shopee) — aparece no
// topbar de toda página ML para ir e voltar entre os dashboards dedicados.
// Só o link, não o menu lateral: a sidebar de cada marketplace é independente
// (ver dashboard-amazon.html/dashboard-shopee.html, que não usam este
// layout.js) para nunca misturar o menu de uma loja com o de outra.
function buildMarketplaceSwitcher() {
  const items = [
    { href: '../index.html', icon: 'fa-shopping-bag', label: 'Mercado Livre', active: true },
    { href: 'dashboard-amazon.html', icon: 'fab fa-amazon', label: 'Amazon' },
    { href: 'dashboard-shopee.html', icon: 'fa-store', label: 'Shopee' },
  ];
  return `<nav class="mkt-switcher-compact">${items.map(i => `
    <a href="${i.href}" class="${i.active ? 'active' : ''}"><i class="${i.icon.startsWith('fab') ? i.icon : 'fas ' + i.icon}"></i> ${i.label}</a>
  `).join('')}</nav>`;
}

function buildTopbar(title) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle" id="menuToggle"><i class="fas fa-bars"></i></button>
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-right">
        ${buildMarketplaceSwitcher()}
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
  initAlerts();
});

// ── Alertas globais: som + notificação do browser ──────────
function initAlerts() {
  // Solicitar permissão de notificação ao abrir o dashboard
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Som gerado via Web Audio API — sem arquivo externo
  function playBeep(freq = 880, duration = 0.18, volume = 0.4) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch(e) {}
  }

  function showToast(title, body, icon) {
    // Toast visual na tela
    const t = document.createElement('div');
    t.style.cssText = `
      position:fixed;top:20px;right:20px;z-index:99999;
      background:#1a1a2e;border:1px solid #f59e0b;border-radius:12px;
      padding:14px 18px;max-width:320px;box-shadow:0 8px 30px rgba(0,0,0,.5);
      display:flex;gap:12px;align-items:flex-start;cursor:pointer;
      animation:slideIn .3s ease;
    `;
    t.innerHTML = `
      <span style="font-size:1.4rem">${icon}</span>
      <div>
        <div style="font-weight:700;font-size:.9rem;color:#f59e0b;margin-bottom:3px">${title}</div>
        <div style="font-size:.8rem;color:#ccc;line-height:1.4">${body}</div>
      </div>
      <span onclick="this.parentNode.remove()" style="color:#666;font-size:1rem;margin-left:auto;cursor:pointer">✕</span>
    `;
    if (!document.querySelector('#toast-style')) {
      const s = document.createElement('style');
      s.id = 'toast-style';
      s.textContent = '@keyframes slideIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}';
      document.head.appendChild(s);
    }
    document.body.appendChild(t);
    t.addEventListener('click', () => { t.remove(); window.location.href = '../pages/perguntas.html'; });
    setTimeout(() => t.style.animation = 'slideIn .3s ease reverse', 4700);
    setTimeout(() => t.remove(), 5000);

    // Notificação nativa do browser (funciona mesmo com aba em background)
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, icon: '/favicon.ico', tag: 'ml-question' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }

  WS.on('_connected', () => {
    const el = document.getElementById('wsStatus');
    if (el) el.innerHTML = '<i class="fas fa-circle" style="color:var(--green);font-size:8px"></i> ao vivo';
  });

  WS.on('_disconnected', () => {
    const el = document.getElementById('wsStatus');
    if (el) el.innerHTML = '<i class="fas fa-circle" style="color:var(--orange);font-size:8px"></i> reconectando...';
  });

  // Escuta pergunta nova
  WS.on('question_received', payload => {
    if (payload?.status !== 'UNANSWERED') return;
    playBeep(880, 0.15);
    setTimeout(() => playBeep(1100, 0.15), 180);
    showToast('❓ Nova Pergunta!', payload.text?.slice(0, 120) || 'Clique para responder', '❓');

    // Badge vermelho no link de Perguntas na sidebar
    const link = document.querySelector('a[href*="perguntas.html"]');
    if (link && !link.querySelector('.q-badge')) {
      const b = document.createElement('span');
      b.className = 'q-badge';
      b.style.cssText = 'background:var(--red);color:#fff;border-radius:10px;font-size:.65rem;padding:1px 6px;margin-left:6px;';
      b.textContent = '!';
      link.appendChild(b);
    }
  });

  // Escuta nova mensagem de comprador
  WS.on('message_received', payload => {
    playBeep(660, 0.15);
    setTimeout(() => playBeep(880, 0.15), 180);
    showToast('💬 Nova Mensagem!', payload.buyer_nickname || 'Comprador enviou mensagem', '💬');
  });
}
