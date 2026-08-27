// Modal de detalhe de produto (drill-down) da Inteligência de Margem —
// gráfico temporal, decomposição em cascata, simulador de preço livre e
// ações recomendadas pro produto. Compartilhado entre bi-margem-produtos.html
// (linha clicável) e bi-margem-portfolio.html (ponto da matriz clicável) —
// extraído aqui na Fase C pra não duplicar (nunca 2ª cópia da mesma lógica,
// ver .claude/workflow.md). Injeta o próprio HTML/CSS no <body>/<head> na
// primeira chamada — páginas estáticas sem build não têm como "incluir um
// componente", então o script se auto-instala (ver .claude/frontend.md).
//
// Depende de globais já definidos em TODA página do BI (mesmo padrão
// repetido em cada uma): DB (js/db.js), Chart (Chart.js CDN, opcional — só
// se ausente o gráfico não renderiza, o resto do modal funciona), BRL/INT/
// PCT1/esc/dataBR, e `document.getElementById('imDays')`/`'imLoja'` pros
// filtros de período/loja da página que chamou. `DADOS.acoes` (payload de
// /api/bi/margem já carregado pela página) é reaproveitado, nunca recalculado.
(function () {
  const MODAL_HTML = `
<div class="modal-overlay" id="modalDetalhe" onclick="if(event.target===this) fecharDetalheProduto()">
  <div class="modal-card">
    <div class="modal-hd">
      <img id="mdThumb" src="" onerror="this.style.display='none'">
      <div>
        <h2 id="mdTitle">—</h2>
        <div class="im-status" id="mdSub"></div>
      </div>
      <button class="modal-close" onclick="fecharDetalheProduto()"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="modal-section">
      <h4><i class="fas fa-chart-line"></i> Evolução (faturamento e MC%)</h4>
      <canvas id="mdChart" height="90"></canvas>
    </div>
    <div class="modal-section">
      <h4><i class="fas fa-water"></i> Decomposição da margem (soma do período)</h4>
      <div class="cascata" id="mdCascata"></div>
    </div>
    <div class="modal-section">
      <h4><i class="fas fa-sliders"></i> Simulador de preço</h4>
      <div class="sim-row">
        <span>Aumento de preço:</span>
        <input type="number" id="mdSimPct" value="5" step="1" oninput="renderSimulador()"> %
      </div>
      <div class="sim-grid" id="mdSimGrid"></div>
      <p class="sim-premissa"><i class="fas fa-circle-info"></i> Impacto estimado considerando volume constante — tarifa/imposto escalam com o preço (são %), custo e frete do vendedor ficam fixos por unidade.</p>
    </div>
    <div class="modal-section" id="mdAcoesWrap" style="display:none">
      <h4><i class="fas fa-list-check"></i> Ações recomendadas pra este produto</h4>
      <div class="acoes-produto" id="mdAcoes"></div>
    </div>
  </div>
</div>`;

  const MODAL_CSS = `
    .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.7); backdrop-filter:blur(2px); z-index:1000; align-items:flex-start; justify-content:center; overflow-y:auto; padding:40px 16px; }
    .modal-overlay.on { display:flex; }
    .modal-card { background:var(--bg-card); border:1px solid var(--border); border-radius:16px; max-width:820px; width:100%; padding:22px 26px; }
    .modal-hd { display:flex; align-items:flex-start; gap:14px; margin-bottom:16px; }
    .modal-hd img { width:56px; height:56px; border-radius:10px; object-fit:cover; background:var(--bg-card2); flex:none; }
    .modal-hd h2 { font-size:16px; font-weight:800; margin:0 0 4px; }
    .modal-close { margin-left:auto; background:transparent; border:0; color:var(--text-muted); font-size:18px; cursor:pointer; }
    .modal-section { margin-bottom:20px; }
    .modal-section h4 { font-size:12px; text-transform:uppercase; letter-spacing:.3px; color:var(--text-muted); margin:0 0 10px; }
    .cascata { display:flex; flex-direction:column; gap:0; }
    .cascata-row { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; font-size:13px; border-left:3px solid var(--border); }
    .cascata-row.venda { border-left-color:#60a5fa; font-weight:700; }
    .cascata-row.neg { border-left-color:#f87171; color:#f87171; }
    .cascata-row.final { border-left-color:#3fb950; font-weight:800; background:rgba(63,185,80,.08); border-radius:0 8px 8px 0; }
    .cascata-row.final.neg { border-left-color:#f87171; background:rgba(248,113,113,.08); }
    .sim-row { display:flex; gap:10px; align-items:center; margin-bottom:12px; }
    .sim-row input { width:80px; background:var(--bg-card2); border:1px solid var(--border); color:var(--text-main); border-radius:8px; padding:7px 10px; font-size:13px; text-align:right; }
    .sim-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
    .sim-cell { background:var(--bg-card2); border-radius:10px; padding:10px 12px; }
    .sim-cell .k { font-size:10px; color:var(--text-muted); font-weight:700; }
    .sim-cell .v { font-size:15px; font-weight:800; margin-top:2px; }
    .sim-premissa { font-size:11px; color:var(--text-muted); font-style:italic; margin-top:8px; }
    .acoes-produto { display:flex; flex-direction:column; gap:6px; }
    .acao-mini { background:var(--bg-card2); border-radius:8px; padding:8px 12px; font-size:12px; }
    .acao-mini b { color:#8b5cf6; }`;

  let instalado = false;
  function garantirModal() {
    if (instalado) return;
    if (!document.getElementById('biMargemProdutoModalCss')) {
      const style = document.createElement('style');
      style.id = 'biMargemProdutoModalCss';
      style.textContent = MODAL_CSS;
      document.head.appendChild(style);
    }
    document.body.insertAdjacentHTML('beforeend', MODAL_HTML);
    instalado = true;
  }

  const TIPO_LABEL = { PAUSAR_OU_RENEGOCIAR: 'Pausar ou renegociar', REPRECIFICAR: 'Reprecificar', AUMENTAR_EXPOSICAO: 'Aumentar exposição', REPOR_ESTOQUE: 'Repor estoque', REVISAR_FRETE: 'Revisar frete' };
  let MD = null; // { resumo, serie } do produto aberto no modal
  let mdChartInstance = null;

  window.abrirDetalheProduto = async function (itemId) {
    garantirModal();
    document.getElementById('modalDetalhe').classList.add('on');
    document.getElementById('mdTitle').textContent = 'Carregando…';
    document.getElementById('mdChart').style.display = 'none';
    document.getElementById('mdCascata').innerHTML = '';
    document.getElementById('mdSimGrid').innerHTML = '';
    const diasFiltro = document.getElementById('imDays') ? Number(document.getElementById('imDays').value) : 60;
    const dias = Math.max(60, diasFiltro || 60);
    const loja = document.getElementById('imLoja') ? document.getElementById('imLoja').value : '';
    const d = await DB.getBiMargemProduto(itemId, dias, loja);
    if (!d || d.error || !d.resumo) {
      document.getElementById('mdTitle').textContent = 'Sem dados suficientes';
      document.getElementById('mdSub').textContent = (d && d.error) || 'Este anúncio não teve vendas na janela consultada.';
      MD = null;
      return;
    }
    MD = d;
    document.getElementById('mdThumb').src = d.resumo.thumbnail || '';
    document.getElementById('mdThumb').style.display = d.resumo.thumbnail ? '' : 'none';
    document.getElementById('mdTitle').textContent = d.resumo.title || d.resumo.item_id;
    document.getElementById('mdSub').textContent = `${d.resumo.pedidos} pedido(s) · ${INT(d.resumo.qtd)} unidade(s) · últimos ${d.dias} dias`;
    document.getElementById('mdChart').style.display = '';
    renderCascata(d.resumo);
    renderGraficoTemporal(d.serie);
    window.renderSimulador();
    renderAcoesProduto(itemId);
  };

  window.fecharDetalheProduto = function () {
    const overlay = document.getElementById('modalDetalhe');
    if (overlay) overlay.classList.remove('on');
    if (mdChartInstance) { mdChartInstance.destroy(); mdChartInstance = null; }
  };

  // Decomposição em cascata: Venda → Tarifa → Frete → CMV → Imposto → MC,
  // soma do período (mesma fórmula de finance.md, só mostrada passo a passo).
  function renderCascata(r) {
    const linhas = [
      { label: 'Venda', valor: r.faturamento, cls: 'venda' },
      { label: 'Tarifa', valor: -r.tarifa, cls: 'neg' },
      { label: 'Frete do vendedor', valor: -r.frete_vendedor, cls: 'neg' },
      { label: 'CMV (custo)', valor: -r.custo, cls: 'neg' },
      { label: 'Imposto', valor: -r.imposto, cls: 'neg' },
      { label: 'Margem de Contribuição', valor: r.margem, cls: `final ${r.margem < 0 ? 'neg' : ''}` },
    ];
    document.getElementById('mdCascata').innerHTML = linhas.map(l => `
      <div class="cascata-row ${l.cls}"><span>${l.label}</span><span>${l.valor >= 0 && l.cls !== 'venda' && !l.cls.includes('final') ? '+' : ''}${BRL(l.valor)}</span></div>`).join('');
  }

  function renderGraficoTemporal(serie) {
    if (mdChartInstance) { mdChartInstance.destroy(); mdChartInstance = null; }
    if (!serie.length || typeof Chart === 'undefined') return;
    const ctx = document.getElementById('mdChart').getContext('2d');
    mdChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: serie.map(s => dataBR(s.dia)),
        datasets: [
          { label: 'Faturamento (R$)', data: serie.map(s => s.faturamento), borderColor: '#60a5fa', backgroundColor: 'transparent', yAxisID: 'y', tension: .25 },
          { label: 'MC %', data: serie.map(s => s.mc_pct), borderColor: '#3fb950', backgroundColor: 'transparent', yAxisID: 'y1', tension: .25 },
        ],
      },
      options: {
        responsive: true, interaction: { mode: 'index', intersect: false },
        scales: {
          y: { type: 'linear', position: 'left', ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,.06)' } },
          y1: { type: 'linear', position: 'right', ticks: { color: '#9ca3af' }, grid: { display: false } },
          x: { ticks: { color: '#9ca3af' }, grid: { display: false } },
        },
        plugins: { legend: { labels: { color: '#9ca3af' } } },
      },
    });
  }

  // Simulador de preço livre — 100% client-side (mesma fórmula das ações
  // REPRECIFICAR, só sem round-trip: %pct escolhido pelo usuário, não fixo).
  window.renderSimulador = function () {
    if (!MD) return;
    const r = MD.resumo;
    const pct = Number(document.getElementById('mdSimPct').value) || 0;
    const novoPreco = r.unit_price_atual * (1 + pct / 100);
    const impacto = Math.max(0, (pct / 100) * (r.faturamento - r.imposto - r.tarifa));
    const novaMargem = r.margem + impacto;
    const novoFaturamento = r.faturamento * (1 + pct / 100);
    const novaMcPct = novoFaturamento > 0 ? (novaMargem / novoFaturamento) * 100 : 0;
    document.getElementById('mdSimGrid').innerHTML = `
      <div class="sim-cell"><div class="k">Preço atual</div><div class="v">${BRL(r.unit_price_atual)}</div></div>
      <div class="sim-cell"><div class="k">Novo preço</div><div class="v">${BRL(novoPreco)}</div></div>
      <div class="sim-cell"><div class="k">MC atual</div><div class="v">${PCT1(r.mc_pct)}</div></div>
      <div class="sim-cell"><div class="k">Nova MC%</div><div class="v" style="color:${novaMcPct >= r.mc_pct ? '#3fb950' : '#f87171'}">${PCT1(novaMcPct)}</div></div>
      <div class="sim-cell"><div class="k">Impacto no período</div><div class="v" style="color:#3fb950">+${BRL(impacto)}</div></div>`;
  };

  // Ações recomendadas já calculadas pelo backend (DADOS.acoes, mesmo
  // payload de /api/bi/margem que a página já carregou) — reaproveitadas
  // aqui filtrando por item_id, nunca recalculadas.
  function renderAcoesProduto(itemId) {
    const wrap = document.getElementById('mdAcoesWrap'), el = document.getElementById('mdAcoes');
    // `DADOS` é `let` no escopo top-level do <script> de cada página — não é
    // propriedade de `window`, mas continua visível aqui (scripts clássicos
    // sem type="module" compartilham o mesmo ambiente léxico global).
    const acoes = ((typeof DADOS !== 'undefined' && DADOS && DADOS.acoes) || []).filter(a => a.item_id === itemId);
    wrap.style.display = acoes.length ? '' : 'none';
    el.innerHTML = acoes.map(a => `<div class="acao-mini"><b>${TIPO_LABEL[a.tipo] || a.tipo}</b> — ${esc(a.problema)}</div>`).join('');
  }
})();
