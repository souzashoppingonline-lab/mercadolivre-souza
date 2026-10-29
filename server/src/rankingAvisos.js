// Mensagens do Telegram pras mudanças FEITAS NO CARD do Rankeamento (entrou,
// mudou de estágio, pausou/retomou, marco, campanha/ADS, novo ciclo, anotação/
// intervenção, vínculo, preço da campanha, saiu). PURO (testado em
// test/rankingAvisos.test.js). Quem envia é routes/ranking.js via
// ranking.emit() — mesma linha do tempo do card + Telegram (tg_rankeamento).
// Pedido do usuário: "sempre que houver alguma mudança de rankeamento enviar
// pro Telegram".
const { faseLabel } = require('./rankingFases');

const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const curto = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const linkOf = mlId => `https://www.mercadolivre.com.br/anuncios/${String(mlId).replace('MLB', 'MLB-')}`;
const cab = (ico, titulo, ad) => [`${ico} <b>${titulo}</b>`, `📦 ${esc(curto(ad.title || ad.ml_id, 80))}`, `🏷️ <code>${esc(ad.ml_id)}</code>`];
const rodape = ad => `🔗 ${linkOf(ad.ml_id)}`;

const CAMPOS_ADS = {
  campanha_nome: ['📣 Campanha', v => esc(v || '—')],
  ads_investido: ['💸 Investido em ADS', v => (v == null ? '—' : BRL(v))],
  roas: ['📈 ROAS', v => (v == null ? '—' : String(Number(v)))],
  orcamento_diario: ['🗓️ Orçamento diário', v => (v == null ? '—' : BRL(v))],
  preco_anterior: ['🏷️ Preço anterior', v => (v == null ? '—' : BRL(v))],
  preco_atual: ['💲 Preço atual', v => (v == null ? '—' : BRL(v))],
};
const TIPOS_NOTA = { titulo: '🏷️ Título', keywords: '🔑 Palavras-chave', fotos: '📸 Fotos', descricao: '📝 Descrição', preco: '💲 Preço', ads: '📣 ADS', atributos: '🧩 Atributos', frete: '🚚 Frete', outro: '🔧 Outro' };

const igual = (a, b) => (a == null || a === '' ? null : String(a)) === (b == null || b === '' ? null : String(b))
  || (a != null && b != null && a !== '' && b !== '' && !isNaN(a) && !isNaN(b) && Number(a) === Number(b));

module.exports = {
  entrou(ad, { reativado = false } = {}) {
    return [...cab('➕', reativado ? 'Voltou pro Rankeamento' : 'Entrou no Rankeamento', ad),
      `📍 Estágio: <b>${faseLabel(ad.fase)}</b>`,
      ...(Number(ad.sales_count) ? [`🔢 ${ad.sales_count} venda(s) acumulada(s) — a contagem continua`] : []),
      `🎯 Marco a cada ${ad.milestone_every || 5} vendas`, rodape(ad)].join('\n');
  },
  fase(ad, de, para) {
    return [...cab('🔀', 'Mudou de estágio', ad), `${faseLabel(de)}  ➜  <b>${faseLabel(para)}</b>`,
      `🔢 ${Number(ad.sales_count) || 0} venda(s) acumulada(s) — o nº continua`, rodape(ad)].join('\n');
  },
  pausa(ad, ativo) {
    return [...cab(ativo ? '▶️' : '⏸️', ativo ? 'Acompanhamento retomado' : 'Acompanhamento pausado', ad),
      `📍 ${faseLabel(ad.fase)}`].join('\n');
  },
  marco(ad, de, para) {
    return [...cab('🎯', 'Marco alterado', ad), `a cada ${de} vendas  ➜  <b>a cada ${para} vendas</b>`].join('\n');
  },
  // ad: linha de ranking_ads já atualizada; antes: linha antes do PATCH;
  // novos: { campo: valor } só dos campos enviados. null se nada mudou de fato.
  ads(ad, antes, novos) {
    const L = Object.keys(CAMPOS_ADS).filter(k => Object.prototype.hasOwnProperty.call(novos, k) && !igual(antes[k], novos[k]))
      .map(k => `${CAMPOS_ADS[k][0]}: ${CAMPOS_ADS[k][1](antes[k])}  ➜  <b>${CAMPOS_ADS[k][1](novos[k])}</b>`);
    if (!L.length) return null;
    return [...cab('📣', 'Campanha / ADS atualizada', ad), `📍 ${faseLabel(ad.fase)} · 🔄 Ciclo ${ad.ciclo || 1}`, '', ...L].join('\n');
  },
  ciclo(ad, de, para) {
    return [...cab('🔄', `Novo ciclo (manual): Ciclo ${de} ➜ Ciclo ${para}`, ad),
      `🔢 ${Number(ad.sales_count) || 0} venda(s) acumulada(s)`, `📍 ${faseLabel(ad.fase)}`].join('\n');
  },
  nota(ad, texto, tipo) {
    return [...cab(tipo ? '🔧' : '📝', tipo ? `Intervenção: ${TIPOS_NOTA[tipo] || tipo}` : 'Anotação no card', ad),
      `📍 ${faseLabel(ad.fase)}`, '', `💬 <i>${esc(curto(texto, 400))}</i>`].join('\n');
  },
  link(ad, mlId, tipo, vinculou) {
    return [...cab('🔗', vinculou ? 'Anúncio vinculado ao card' : 'Anúncio desvinculado do card', ad),
      `${vinculou ? '➕' : '➖'} <code>${esc(mlId)}</code>${tipo ? ` (${esc(tipo)})` : ''}`,
      vinculou ? 'As vendas dele passam a contar neste card.' : 'As vendas dele deixam de contar neste card.'].join('\n');
  },
  precoManual(ad, de, para) {
    return [...cab('💲', 'Preço da campanha registrado', ad), `${de != null ? BRL(de) : '—'}  ➜  <b>${BRL(para)}</b>`].join('\n');
  },
  saiu(ad) {
    return [...cab('🗑️', 'Saiu do Rankeamento', ad), `📍 Estava em: ${faseLabel(ad.fase)}`,
      `🔢 Terminou com <b>${Number(ad.sales_count) || 0}</b> venda(s)`].join('\n');
  },
};
