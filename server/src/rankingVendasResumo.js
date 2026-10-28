// Resumo de vendas do Rankeamento POR ESTÁGIO no Telegram (pedido do usuário):
//  • a cada 4h — vendas desde o último resumo, por estágio, + "hoje até agora";
//  • 1x por dia — fechamento do dia anterior inteiro, por estágio.
// PURO (testado em test/rankingVendasResumo.test.js); dados e envio nos jobs
// checkRankingVendas4h / checkRankingVendasDia do worker.js.
// Estágio da venda = o gravado no evento (detail.fase, desde esta versão) ou,
// em evento antigo, o estágio atual do anúncio.
const { faseLabel } = require('./rankingFases');

const FASES = ['rankeando', 'catalogo', 'ranqueado', 'monitoramento', 'recuperacao'];
const MAX_ADS = 8;
const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const curto = (t, n = 45) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const icone = f => faseLabel(f).split(' ')[0];

// rows: [{ fase, ml_id, title, vendas, valor, nro }] (1 linha por anúncio+estágio)
// hoje: [{ fase, vendas }] (opcional — só no resumo de 4h)
// Visual (pedido do usuário): bastante espaço e emoji — um bloco por estágio
// separado por linha, medalha nos 3 que mais venderam, "😴" quando não vendeu.
const SEP = '━━━━━━━━━━━━━━━━';
const MEDALHA = ['🥇', '🥈', '🥉'];
function montarResumo(rows, { titulo, periodo, hoje = null }) {
  const por = new Map(FASES.map(f => [f, []]));
  rows.forEach(r => { const f = por.has(r.fase) ? r.fase : 'rankeando'; por.get(f).push(r); });
  let total = 0, totalValor = 0;
  const L = [`📊 <b>${esc(titulo)}</b>`, `🕐 <i>${esc(periodo)}</i>`];
  FASES.forEach(f => {
    const ads = por.get(f).slice().sort((a, b) => Number(b.vendas) - Number(a.vendas) || String(a.title).localeCompare(String(b.title)));
    const n = ads.reduce((s, a) => s + Number(a.vendas), 0), v = ads.reduce((s, a) => s + Number(a.valor || 0), 0);
    total += n; totalValor += v;
    const [ico, ...nome] = faseLabel(f).split(' ');
    L.push('', SEP, `${ico} <b>${esc(nome.join(' ').toUpperCase())}</b>`);
    if (!n) { L.push('😴 Nenhuma venda'); return; }
    L.push(`🛒 <b>${n}</b> venda(s)   💰 <b>${BRL(v)}</b>`, '');
    ads.slice(0, MAX_ADS).forEach((a, k) => {
      L.push(`${MEDALHA[k] || '🔹'} ${esc(curto(a.title || a.ml_id))}`);
      L.push(`      ➜ <b>${a.vendas}</b> venda(s)${a.nro ? `   🔢 venda nº <b>${a.nro}</b>` : ''}`);
    });
    if (ads.length > MAX_ADS) L.push(`➕ <i>+${ads.length - MAX_ADS} anúncio(s)</i>`);
  });
  L.push('', SEP, `🧮 <b>TOTAL: ${total} venda(s)</b>`, `💰 <b>${BRL(totalValor)}</b>`);
  if (hoje) {
    const m = Object.fromEntries(hoje.map(h => [h.fase, Number(h.vendas)]));
    const t = FASES.reduce((s, f) => s + (m[f] || 0), 0);
    L.push('', `📅 <b>Hoje até agora: ${t} venda(s)</b>`, FASES.map(f => `${icone(f)} ${m[f] || 0}`).join('   '));
  }
  return { texto: L.join('\n'), total };
}

module.exports = { montarResumo, FASES };
