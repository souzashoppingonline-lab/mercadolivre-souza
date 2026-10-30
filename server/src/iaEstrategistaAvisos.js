// Textos do Telegram da IA Estrategista (PURO — testado em
// test/iaEstrategistaAvisos.test.js). Quem envia: jobs do worker.js
// (checkIaEstrategistaDiario 08:05 e checkIaEstrategistaCriticos a cada 2h).
// Visual pedido pelo usuário em todo aviso: bastante espaço e emoji.
const { faseLabel } = require('./rankingFases');

const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(Number(n) || 0);
const BRL2 = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const NUM = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const curto = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const SEP = '━━━━━━━━━━━━━━━━';
const MEDALHA = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
const link = (dashUrl, id) => (dashUrl ? `${dashUrl}/pages/bi-ia-estrategista.html${id ? `?anuncio=${id}` : ''}` : '');
const STATUS = { pendente: '⏳ Pendente', em_execucao: '🔧 Em execução' };

function blocoAnuncio(x, ico) {
  const L = [`${ico} <b>[${x.prioridade.nota}] ${esc(curto(x.titulo, 60))}</b>`,
    `🏪 ${esc(x.loja || '—')} · <code>${esc(x.ml_id)}</code> · ${faseLabel(x.fase)}`,
    `${x.analise.principal.ico} <b>${esc(x.analise.principal.nome)}</b>`];
  const prob = x.analise.problemas[0]?.texto || x.analise.oportunidades[0]?.texto || x.analise.faltando[0];
  if (prob) L.push(`⚠️ ${esc(curto(prob, 220))}`);
  if (x.analise.plano[0]) L.push(`👉 <b>1ª ação:</b> ${esc(curto(x.analise.plano[0].acao, 220))}`);
  if (x.analise.impacto_mensal > 0) L.push(`💸 Impacto: ~${BRL(x.analise.impacto_mensal)}/mês <i>(estimativa)</i>`);
  return L.join('\n');
}

// r = carteira analisada (iaEstrategistaDados.carteira); novosCriticos = anúncios que entraram em 80+.
function textoPrioridades(r, { novosCriticos = [], dashUrl = '', agora = new Date() } = {}) {
  const top = r.anuncios.filter(x => x.prioridade.nota >= 20).slice(0, 5);
  const dia = new Date(agora).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit' });
  const L = [`🧠 <b>IA ESTRATEGISTA — PRIORIDADES DO DIA</b>`, `🕐 <i>${dia} · últimos ${r.periodo.dias} dias fechados</i>`, '',
    `📊 <b>${r.painel.analisados}</b> anúncio(s) analisado(s) · 🚨 <b>${r.painel.precisam_intervencao}</b> precisam de intervenção`,
    `💰 Potencial identificado: <b>${BRL(r.painel.potencial_faturamento_mensal)}</b>/mês <i>(estimativa)</i>`];
  if (!top.length) L.push('', SEP, '✅ Nenhum anúncio com prioridade relevante hoje. Bom trabalho!');
  top.forEach((x, i) => L.push('', SEP, blocoAnuncio(x, MEDALHA[i])));
  if (novosCriticos.length) {
    L.push('', SEP, '🚨 <b>ENTRARAM EM CRÍTICO (80+) DESDE ONTEM</b>', '');
    novosCriticos.forEach(c => L.push(`🔴 ${esc(curto(c.x.titulo, 55))} — ${c.antes == null ? 'novo' : c.antes} ➜ <b>${c.x.prioridade.nota}</b>`));
  }
  const u = link(dashUrl);
  if (u) L.push('', `📲 <a href="${u}">Abrir IA Estrategista</a>`);
  return L.join('\n');
}

function textoCriticos(lista, { dashUrl = '' } = {}) {
  const L = ['🚨 <b>ANÚNCIO ENTROU EM CRÍTICO (80+)</b>', '<i>agir imediatamente</i>'];
  lista.forEach(c => {
    L.push('', SEP, blocoAnuncio(c.x, '🔴'), `📈 Prioridade: ${c.antes == null ? '—' : c.antes} ➜ <b>${c.x.prioridade.nota}</b>`);
    const u = link(dashUrl, c.x.ranking_ad_id);
    if (u) L.push(`📲 <a href="${u}">Abrir o plano</a>`);
  });
  return L.join('\n');
}

const diasDesde = (d, agora) => Math.floor((new Date(agora) - new Date(d)) / 86400000);
function textoParadas(acoes, { dashUrl = '', agora = new Date() } = {}) {
  const L = ['⏰ <b>AÇÕES PARADAS HÁ MAIS DE 7 DIAS</b>', `<i>${acoes.length} recomendação(ões) sem andamento</i>`];
  acoes.forEach(a => {
    L.push('', SEP, `📦 <b>${esc(curto(a.produto || a.ml_id, 60))}</b>`, `👉 ${esc(curto(a.acao, 200))}`,
      `${STATUS[a.status] || a.status} há <b>${diasDesde(a.status_desde, agora)} dia(s)</b> · 👤 ${esc(a.responsavel || 'sem responsável')}`);
  });
  const u = link(dashUrl);
  if (u) L.push('', `📲 <a href="${u}">Atualizar no Acompanhamento</a>`);
  return L.join('\n');
}

// Resumo de 1 linha que vai pro campo "Resultado observado" (texto puro).
function resumoResultado(a) {
  const ad = a.antes_depois; if (!ad) return null;
  const v = (x, y) => (x ? ` (${y >= x ? '+' : ''}${NUM(((y - x) / x) * 100)}%)` : '');
  const partes = [`pedidos/dia ${NUM(ad.antes.pedidos_dia)} → ${NUM(ad.depois.pedidos_dia)}${v(ad.antes.pedidos_dia, ad.depois.pedidos_dia)}`,
    `faturamento/dia ${BRL2(ad.antes.fat_dia)} → ${BRL2(ad.depois.fat_dia)}`];
  if (ad.antes.mc_pct != null && ad.depois.mc_pct != null) partes.push(`MC ${NUM(ad.antes.mc_pct)}% → ${NUM(ad.depois.mc_pct)}%`);
  if (ad.antes.conversao != null && ad.depois.conversao != null) partes.push(`conversão ${NUM(ad.antes.conversao)}% → ${NUM(ad.depois.conversao)}%`);
  return `[automático] ${a.produto || a.ml_id}: ${partes.join(' · ')} depois da ação (14 dias antes × ${ad.dias_depois} dias depois; associação temporal, não prova causa).`;
}

function textoResultado(a, { dashUrl = '' } = {}) {
  const ad = a.antes_depois;
  const seta = (x, y) => (y > x ? '⬆️' : y < x ? '⬇️' : '➡️');
  const pct = (x, y) => (x ? ` <i>(${y >= x ? '+' : ''}${NUM(((y - x) / x) * 100)}%)</i>` : '');
  const L = ['📊 <b>RESULTADO DA AÇÃO</b>', `<i>${ad.dias_depois} dias depois de concluída</i>`, '',
    `📦 <b>${esc(curto(a.produto || a.ml_id, 60))}</b>`, `✅ ${esc(curto(a.acao, 200))}`, '',
    `🛒 Pedidos/dia: ${NUM(ad.antes.pedidos_dia)} ➜ <b>${NUM(ad.depois.pedidos_dia)}</b> ${seta(ad.antes.pedidos_dia, ad.depois.pedidos_dia)}${pct(ad.antes.pedidos_dia, ad.depois.pedidos_dia)}`,
    `💰 Faturamento/dia: ${BRL2(ad.antes.fat_dia)} ➜ <b>${BRL2(ad.depois.fat_dia)}</b> ${seta(ad.antes.fat_dia, ad.depois.fat_dia)}`,
    `💵 Margem/dia: ${BRL2(ad.antes.margem_dia)} ➜ <b>${BRL2(ad.depois.margem_dia)}</b> ${seta(ad.antes.margem_dia, ad.depois.margem_dia)}`];
  if (ad.antes.mc_pct != null && ad.depois.mc_pct != null) L.push(`📈 MC: ${NUM(ad.antes.mc_pct)}% ➜ <b>${NUM(ad.depois.mc_pct)}%</b> (${ad.depois.mc_pct >= ad.antes.mc_pct ? '+' : ''}${NUM(ad.depois.mc_pct - ad.antes.mc_pct)} p.p.)`);
  if (ad.antes.conversao != null && ad.depois.conversao != null) L.push(`🎯 Conversão: ${NUM(ad.antes.conversao)}% ➜ <b>${NUM(ad.depois.conversao)}%</b>`);
  L.push('', '<i>⚠️ Associação temporal — não prova que a ação causou a mudança.</i>');
  const u = link(dashUrl, a.ranking_ad_id);
  if (u) L.push(`📲 <a href="${u}">Ver o anúncio</a>`);
  return L.join('\n');
}

module.exports = { textoPrioridades, textoCriticos, textoParadas, textoResultado, resumoResultado };
