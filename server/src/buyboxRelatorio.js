// Relatório diário de Buy Box (catálogo) no Telegram, POR EMPRESA (loja ML):
// 🔴 perdendo · 🟡 compartilhando (empatado no 1º lugar) · 🟢 ganhando, sempre
// com o PREÇO DO VENCEDOR em quem não está ganhando. Texto PURO (testado em
// test/buyboxRelatorio.test.js); dados e envio no job checkBuyboxRelatorio do
// worker.js (08:30, depois do sync-catalog-competition das 04:50).
//
// Classificação = js/buyboxStatus.js (a MESMA da tela de Rankeamento).
// "Mudou desde o último relatório" compara com o estado salvo no relatório
// anterior (tabela buybox_alerta_estado) — não com catalog_competition_history,
// que só tem a string crua de status.
const { classificar } = require('../../js/buyboxStatus');

const MAX_CHARS = 3800;           // teto do Telegram é 4096 por mensagem
const DIAS_DADO_VELHO = 2;        // sync mais antigo que isso ganha aviso ⏳
const BOOSTS = {
  fulfillment: 'FULL', free_shipping: 'frete grátis', free_installments: 'parcelamento sem juros',
  installments: 'parcelamento', same_day_shipping: 'entrega no mesmo dia', shipping_guaranteed: 'envio garantido',
};
const GRUPOS = [
  ['perdendo', '🔴', 'PERDENDO'],
  ['compartilhando', '🟡', 'COMPARTILHANDO O 1º LUGAR (empatado)'],
  ['ganhando', '🟢', 'GANHANDO'],
];

const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const curto = (t, n = 55) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const num = v => (v == null || v === '' ? null : Number(v));
const ddmm = d => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`; };

// rows: catalog_competition + loja/título/link; estadoAnterior: { item_id: chave }.
function montarRelatorio(rows, estadoAnterior = {}, { agora = new Date(), dashUrl = '' } = {}) {
  const porLoja = new Map();
  const novoEstado = [];
  rows.forEach(r => {
    const st = classificar({ calculado_em: r.calculated_at, winner_item_id: r.winner_item_id, item_id: r.item_id, status: r.status });
    const antes = estadoAnterior[r.item_id] || null;
    const item = {
      ...r, chave: st.chave, antes,
      seu: num(r.current_price) ?? num(r.item_price), vencedor: num(r.winner_price), paraGanhar: num(r.price_to_win),
      velho: r.calculated_at && (new Date(agora) - new Date(r.calculated_at)) / 86400000 > DIAS_DADO_VELHO,
    };
    if (st.chave !== 'aguardando') novoEstado.push({ item_id: r.item_id, chave: st.chave });
    const loja = r.loja || `Loja ${r.store_id}`;
    if (!porLoja.has(loja)) porLoja.set(loja, []);
    porLoja.get(loja).push(item);
  });

  const lojas = [...porLoja.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([loja, itens]) => {
    const g = k => itens.filter(i => i.chave === k);
    const cont = { perdendo: g('perdendo').length, compartilhando: g('compartilhando').length, ganhando: g('ganhando').length, aguardando: g('aguardando').length, sem_concorrencia: g('sem_concorrencia').length };
    const mudou = itens.filter(i => i.antes && i.antes !== i.chave && ['perdendo', 'ganhando', 'compartilhando'].includes(i.chave));
    const cab = [
      `🛒 <b>BUY BOX — ${esc(loja)}</b>`,
      `<i>${ddmm(agora)} · ${itens.length} anúncio(s) de catálogo</i>`,
      '',
      `🟢 Ganhando: <b>${cont.ganhando}</b>   🟡 Empatado: <b>${cont.compartilhando}</b>   🔴 Perdendo: <b>${cont.perdendo}</b>`,
    ];
    if (cont.aguardando || cont.sem_concorrencia) cab.push(`<i>⏳ ${cont.aguardando} aguardando 1º sync · — ${cont.sem_concorrencia} sem concorrente</i>`);
    if (mudou.length) {
      cab.push('', '🔔 <b>MUDOU DESDE O ÚLTIMO RELATÓRIO</b>');
      mudou.forEach(i => cab.push(i.chave === 'ganhando' ? `🎉 Voltou a ganhar: ${esc(curto(i.title, 45))}`
        : i.chave === 'perdendo' ? `⚠️ Perdeu o Buy Box: ${esc(curto(i.title, 45))}` : `🤝 Passou a empatar: ${esc(curto(i.title, 45))}`));
    }

    const blocos = [];
    GRUPOS.forEach(([k, ico, nome]) => {
      let lista = g(k);
      if (!lista.length) return;
      // Perdendo: quem está mais perto de ganhar primeiro (menor diferença pro vencedor).
      if (k === 'perdendo') lista = lista.slice().sort((a, b) => ((a.seu ?? 0) - (a.vencedor ?? 0)) - ((b.seu ?? 0) - (b.vencedor ?? 0)));
      else lista = lista.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      const linhas = [`${ico} <b>${nome} (${lista.length})</b>`];
      lista.forEach((i, n) => {
        const nomeLink = i.permalink ? `<a href="${esc(i.permalink)}">${esc(curto(i.title))}</a>` : esc(curto(i.title || i.item_id));
        // Loja + código do anúncio em cada item (pedido do usuário: achar o
        // anúncio na hora; <code> vira "toque pra copiar" no Telegram).
        const ref = `   🏪 <b>${esc(i.loja || '')}</b> · <code>${esc(i.item_id)}</code>`;
        const L = [`${n + 1}. ${nomeLink}`];
        if (k === 'ganhando') {
          L[0] += ` — <b>${BRL(i.seu)}</b>`;
          L.push(ref);
        } else {
          L.push(ref);
          const dif = i.seu != null && i.vencedor != null ? i.seu - i.vencedor : null;
          L.push(`   💰 Seu: <b>${BRL(i.seu)}</b>  ·  🏆 Vencedor: <b>${i.vencedor != null ? BRL(i.vencedor) : '—'}</b>${dif != null && Math.abs(dif) >= 0.01 ? ` (${dif > 0 ? '+' : '−'}${BRL(Math.abs(dif))})` : ''}`);
          const falta = (i.boosts_missing || []).map(b => BOOSTS[b] || b);
          const dicas = [];
          if (k === 'perdendo' && i.paraGanhar != null) dicas.push(`🎯 Pra ganhar: <b>${BRL(i.paraGanhar)}</b>`);
          if (falta.length) dicas.push(`falta: ${esc(falta.join(', '))}`);
          if (dicas.length) L.push(`   ${dicas.join('  ·  ')}`);
        }
        if (i.velho) L.push(`   <i>⏳ dado de ${ddmm(i.calculated_at)}</i>`);
        linhas.push(L.join('\n'));
      });
      blocos.push(linhas);
    });

    // Quebra em várias mensagens se passar do teto (nunca corta um item ao meio).
    const msgs = [];
    let atual = cab.join('\n');
    const rodape = dashUrl ? `\n\n📊 <a href="${esc(dashUrl)}/pages/rankeamento.html">Abrir no painel</a>` : '';
    blocos.forEach(linhas => {
      linhas.forEach((ln, idx) => {
        const pedaco = (idx === 0 ? '\n\n' : '\n') + ln;
        if ((atual + pedaco).length > MAX_CHARS) { msgs.push(atual); atual = `🛒 <b>BUY BOX — ${esc(loja)}</b> <i>(continuação)</i>\n` + (idx === 0 ? '' : linhas[0] + ' <i>(cont.)</i>') + pedaco; }
        else atual += pedaco;
      });
    });
    msgs.push(atual + rodape);
    return { loja, contagem: cont, mudou: mudou.length, mensagens: msgs };
  });
  return { lojas, novoEstado };
}

module.exports = { montarRelatorio, BOOSTS, MAX_CHARS };
