// Cada ALTERAÇÃO no catálogo (Buy Box) vira aviso no Telegram. PURO (testado
// em test/buyboxMudancas.test.js):
//  • detectarMudancas(antes, depois) — chamado por catalogCompetition.js (o
//    ÚNICO lugar que grava catalog_competition: sync diário/intradia, webhook
//    do ML e alocação no Rankeamento), compara a linha anterior com a nova.
//  • textoMudancas(lista) — mensagens agrupadas por empresa e por anúncio,
//    enviadas pelo job flushBuyboxMudancas do worker.js (a cada 10 min, fora
//    da janela de silêncio). Ver .claude/workers.md.
// Mudanças detectadas: status (perdeu / voltou a ganhar / passou a empatar /
// ficou sem concorrente), preço do vencedor, outro vendedor assumiu o 1º
// lugar, e o seu próprio preço. 1º sync de um anúncio não gera aviso.
const { classificar } = require('../../js/buyboxStatus');
const { BOOSTS, MAX_CHARS } = require('./buyboxRelatorio');

const num = v => (v == null || v === '' ? null : Number(v));
const mudouPreco = (a, b) => a != null && b != null && Math.abs(a - b) >= 0.01;
const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const curto = (t, n = 60) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// antes/depois: { item_id, status, winner_item_id, winner_price, current_price, calculated_at }
function detectarMudancas(antes, depois) {
  if (!antes || !antes.calculated_at || !depois) return [];
  const st = r => classificar({ calculado_em: r.calculated_at || true, winner_item_id: r.winner_item_id, item_id: depois.item_id, status: r.status }).chave;
  const a = st(antes), d = st(depois);
  const out = [];
  if (a !== d) out.push({ tipo: 'status', de: a, para: d });
  else if (d === 'perdendo' || d === 'compartilhando') {
    if (mudouPreco(num(antes.winner_price), num(depois.winner_price))) out.push({ tipo: 'preco_vencedor', de: num(antes.winner_price), para: num(depois.winner_price) });
    if (antes.winner_item_id && depois.winner_item_id && antes.winner_item_id !== depois.winner_item_id) out.push({ tipo: 'novo_vencedor', de: antes.winner_item_id, para: depois.winner_item_id });
  }
  if (mudouPreco(num(antes.current_price), num(depois.current_price))) out.push({ tipo: 'seu_preco', de: num(antes.current_price), para: num(depois.current_price) });
  return out;
}

const TITULO_STATUS = {
  ganhando: de => (de === 'perdendo' || de === 'compartilhando' ? '🎉 <b>VOLTOU A GANHAR o Buy Box</b>' : '🏆 <b>GANHANDO o Buy Box</b>'),
  perdendo: () => '⚠️ <b>PERDEU o Buy Box</b>',
  compartilhando: () => '🤝 <b>PASSOU A EMPATAR</b> (compartilhando o 1º lugar)',
  sem_concorrencia: () => 'ℹ️ <b>Ficou sem concorrente</b> no catálogo',
};
function linhaMudanca(m) {
  if (m.tipo === 'status') return (TITULO_STATUS[m.para] || (() => `🔁 Status: ${esc(m.de)} → ${esc(m.para)}`))(m.de);
  if (m.tipo === 'preco_vencedor') {
    const desceu = Number(m.para) < Number(m.de);
    return `💸 <b>Vencedor ${desceu ? 'BAIXOU' : 'subiu'} o preço</b>: ${BRL(m.de)} → <b>${BRL(m.para)}</b> ${desceu ? '⬇️' : '⬆️'}`;
  }
  if (m.tipo === 'novo_vencedor') return '🔄 <b>Outro vendedor assumiu o 1º lugar</b>';
  if (m.tipo === 'seu_preco') return `✏️ <b>Seu preço mudou</b>: ${BRL(m.de)} → <b>${BRL(m.para)}</b>`;
  return esc(m.tipo);
}
// Peso pra ordem dentro da mensagem: perdeu primeiro, depois preço do vencedor…
const PESO = m => (m.tipo === 'status' ? (m.para === 'perdendo' ? 0 : m.para === 'compartilhando' ? 1 : 2) : m.tipo === 'preco_vencedor' ? 3 : m.tipo === 'novo_vencedor' ? 4 : 5);

// lista: linhas de buybox_mudancas + loja/title/permalink + snapshot atual
// (current_price, winner_price, price_to_win, winner_item_id, item_id,
// boosts_missing, status). → [{ loja, mensagens: [...] }]
function textoMudancas(lista, { agora = new Date() } = {}) {
  const hora = new Date(agora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const porLoja = new Map();
  lista.forEach(m => {
    const loja = m.loja || `Loja ${m.store_id}`;
    if (!porLoja.has(loja)) porLoja.set(loja, new Map());
    const itens = porLoja.get(loja);
    if (!itens.has(m.item_id)) itens.set(m.item_id, { ...m, mudancas: [] });
    itens.get(m.item_id).mudancas.push(m);
  });
  return [...porLoja.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([loja, itens]) => {
    const blocos = [...itens.values()]
      .map(it => ({ ...it, mudancas: it.mudancas.slice().sort((a, b) => PESO(a) - PESO(b)) }))
      .sort((a, b) => PESO(a.mudancas[0]) - PESO(b.mudancas[0]))
      .map(it => {
        const titulo = it.permalink ? `<a href="${esc(it.permalink)}">${esc(curto(it.title || it.item_id))}</a>` : esc(curto(it.title || it.item_id));
        // Loja + código do anúncio (pedido do usuário: identificar na hora; <code> = toque pra copiar).
        const L = [...it.mudancas.map(linhaMudanca), `📦 ${titulo}`, `🏪 <b>${esc(loja)}</b> · <code>${esc(it.item_id)}</code>`];
        const seu = num(it.current_price), venc = num(it.winner_price);
        const ganhando = it.winner_item_id && it.winner_item_id === it.item_id;
        if (ganhando) L.push(`💰 Seu: <b>${BRL(seu)}</b> · 🏆 você é o vencedor`);
        else if (seu != null || venc != null) {
          const dif = seu != null && venc != null ? seu - venc : null;
          L.push(`💰 Seu: <b>${BRL(seu)}</b> · 🏆 Vencedor: <b>${venc != null ? BRL(venc) : '—'}</b>${dif != null && Math.abs(dif) >= 0.01 ? ` (você está ${BRL(Math.abs(dif))} ${dif > 0 ? 'acima' : 'abaixo'})` : ''}`);
          const falta = (it.boosts_missing || []).map(b => BOOSTS[b] || b);
          const dicas = [];
          if (num(it.price_to_win) != null && !ganhando) dicas.push(`🎯 Pra ganhar: <b>${BRL(it.price_to_win)}</b>`);
          if (falta.length) dicas.push(`falta: ${esc(falta.join(', '))}`);
          if (dicas.length) L.push(dicas.join(' · '));
        }
        return L.join('\n');
      });
    const cab = `🔔 <b>CATÁLOGO — ${esc(loja)}</b> · ${hora}\n<i>${itens.size} anúncio(s) com mudança</i>`;
    const SEP = '\n━━━━━━━━━━━━━━\n';
    const msgs = [];
    let atual = cab;
    blocos.forEach(b => {
      if ((atual + SEP + b).length > MAX_CHARS) { msgs.push(atual); atual = `🔔 <b>CATÁLOGO — ${esc(loja)}</b> <i>(continuação)</i>`; }
      atual += SEP + b;
    });
    msgs.push(atual);
    return { loja, itens: itens.size, mensagens: msgs };
  });
}

module.exports = { detectarMudancas, textoMudancas };
