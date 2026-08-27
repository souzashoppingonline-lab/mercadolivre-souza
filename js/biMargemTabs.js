// Barra de navegação compartilhada entre as páginas da Inteligência de
// Margem — cada aba (antes painéis JS numa página só) agora é uma página
// própria, ligada por link real (preserva ?days=&store_id= na troca de
// aba, então o analista não perde o filtro ao navegar). Ver .claude/frontend.md
// (páginas estáticas, sem build) e .claude/decisions.md.
const BI_MARGEM_TABS = [
  { href: 'bi-margem.html',          icon: 'fa-gauge-high',      label: 'Visão Geral' },
  { href: 'bi-margem-produtos.html', icon: 'fa-boxes-stacked',   label: 'Produtos' },
  { href: 'bi-margem-portfolio.html',icon: 'fa-chart-pie',       label: 'Portfólio' },
  { href: 'bi-margem-frete.html',    icon: 'fa-truck-fast',      label: 'Frete & Tarifa' },
  { href: 'bi-margem-estoque.html',  icon: 'fa-warehouse',       label: 'Estoque & Ruptura' },
  { href: 'bi-margem-acoes.html',    icon: 'fa-list-check',      label: 'Ações Recomendadas' },
];

// Lê days/store_id da URL atual (?days=30&store_id=123) — cada página inicia
// os filtros a partir daqui, não sempre em "30 dias/todas as empresas".
function biMargemQueryAtual(){
  const p = new URLSearchParams(location.search);
  return { days: p.get('days') || '30', store_id: p.get('store_id') || '' };
}

// Gera o HTML da barra de abas, cada uma apontando pra sua página com os
// filtros ATUAIS embutidos na querystring. `contadores` é opcional:
// { 'bi-margem-produtos.html': 12, ... } pra mostrar o badge numérico.
function renderBiMargemTabs(paginaAtual, contadores = {}){
  const q = biMargemQueryAtual();
  const qs = `?days=${encodeURIComponent(q.days)}&store_id=${encodeURIComponent(q.store_id)}`;
  return BI_MARGEM_TABS.map(t => {
    const n = contadores[t.href];
    return `<a class="im-tab${t.href === paginaAtual ? ' on' : ''}" href="${t.href}${qs}">
      <i class="fas ${t.icon}"></i> ${t.label}${n != null ? ` <span class="n">${n}</span>` : ''}
    </a>`;
  }).join('');
}
