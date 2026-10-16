// Alerta "dia sem importação" do Metrizap — cálculo PURO (sem banco), usado
// pelo job checkImportacaoMetrizap do worker.js (Telegram, 19:00) via
// routes/biVendas.js (verificarImportacaoMetrizap, que só carrega os dados) e
// pelos testes (test/importacaoMetrizap.test.js). Ver .claude/workers.md.
//
// Três pendências, todas sobre os últimos `janelaDias` dias até ONTEM:
//  1. atrasadas  — dias DEPOIS do último dia importado de cada loja (nem
//                  resumo nem detalhe). Buraco no MEIO do período não conta:
//                  loja pequena tem dia sem venda de verdade, e um alerta que
//                  nunca some vira ruído.
//  2. sem_detalhe — Vendas & Custos (sales_entries, resumo diário) tem
//                  faturamento e Vendas Detalhadas (sales_entries_detail) não
//                  tem, ou tem menos → Inteligência de Vendas/Pareto ficam
//                  sem essas vendas. Reimportar o dia corrige.
//  3. so_no_detalhe — o detalhe soma MAIS que o resumo (venda duplicada entre
//                  lojas ou resumo desatualizado) → conferir.
// 2 e 3 vêm de pareto.conciliarComResumoDiario — a MESMA conciliação do aviso
// da aba Princípio de Pareto (tolerância de R$0,05), nunca uma 2ª cópia.
const { conciliarComResumoDiario } = require('./pareto');

const JANELA_DIAS = 30;
const MAX_DIAS_POR_LOJA = 12; // mensagem do Telegram tem teto de 4096 caracteres

function somaDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dia = v => String(v || '').slice(0, 10);
const ddmm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const escHtml = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// "13/10 a 15/10, 18/10" — dias consecutivos viram faixa.
function faixas(dias) {
  const ord = [...new Set(dias)].sort();
  const out = [];
  for (let i = 0; i < ord.length; i++) {
    let j = i;
    while (j + 1 < ord.length && somaDias(ord[j], 1) === ord[j + 1]) j++;
    out.push(j - i >= 1 ? `${ddmm(ord[i])} a ${ddmm(ord[j])}` : ddmm(ord[i]));
    i = j;
  }
  return out.join(', ');
}

// resumo: linhas de sales_entries ({store_id, date, gross_revenue});
// detalhe: linhas de sales_entries_detail SEM canceladas ({store_id, date,
// faturamento}); lojas: stores ativas ({id, name}); ontem: 'YYYY-MM-DD'
// (data local do Brasil). Linhas fora da janela são ignoradas.
function verificarImportacao({ resumo = [], detalhe = [], lojas = [], ontem, janelaDias = JANELA_DIAS }) {
  const de = somaDias(ontem, -(janelaDias - 1));
  const naJanela = r => { const d = dia(r.date); return d >= de && d <= ontem; };
  const R = resumo.filter(naJanela), D = detalhe.filter(naJanela);
  const nomes = {};
  lojas.forEach(l => { nomes[String(l.id)] = String(l.name || l.nome || '').trim() || String(l.id).slice(0, 8); });
  const ativas = new Set(lojas.map(l => String(l.id)));
  const nome = id => nomes[String(id)] || String(id).slice(0, 8);

  // 1) Último dia importado de cada loja (resumo OU detalhe).
  const ultimo = {};
  [...R, ...D].forEach(r => { const k = String(r.store_id), d = dia(r.date); if (!ultimo[k] || d > ultimo[k]) ultimo[k] = d; });
  const atrasadas = [];
  Object.entries(ultimo).forEach(([id, u]) => {
    if (!ativas.has(id) || u >= ontem) return;
    const dias = [];
    for (let d = somaDias(u, 1); d <= ontem; d = somaDias(d, 1)) dias.push(d);
    atrasadas.push({ store_id: id, loja: nome(id), ultimo: u, dias });
  });

  // 2) e 3) Conciliação resumo × detalhe por loja+dia — só a partir do 1º dia
  // com detalhe importado (qualquer loja): antes disso o detalhe por venda não
  // existia (começou em 01/10/2026) e todo dia antigo viraria "falta detalhe".
  const inicioDetalhe = D.reduce((m, r) => (!m || dia(r.date) < m ? dia(r.date) : m), null);
  const c = inicioDetalhe
    ? conciliarComResumoDiario(R.filter(r => dia(r.date) >= inicioDetalhe), D)
    : { sem_detalhe: { dias: [] }, so_no_detalhe: { dias: [] } };
  const porLoja = lista => {
    const by = {};
    lista.filter(x => ativas.has(String(x.store_id))).forEach(x => {
      (by[x.store_id] = by[x.store_id] || []).push({ date: x.date, valor: x.valor, parcial: !!x.tem_detalhe });
    });
    return Object.entries(by).map(([id, dias]) => ({ store_id: id, loja: nome(id), dias, valor: Math.round(dias.reduce((s, x) => s + x.valor, 0) * 100) / 100 }));
  };
  const ordLoja = (a, b) => a.loja.localeCompare(b.loja);
  const sem_detalhe = porLoja(c.sem_detalhe.dias).sort(ordLoja);
  const so_no_detalhe = porLoja(c.so_no_detalhe.dias).sort(ordLoja);
  atrasadas.sort(ordLoja);

  return {
    de, ate: ontem, janela_dias: janelaDias, inicio_detalhe: inicioDetalhe,
    lojas_com_dados: Object.keys(ultimo).filter(id => ativas.has(id)).length,
    atrasadas, sem_detalhe, so_no_detalhe,
    total: atrasadas.length + sem_detalhe.length + so_no_detalhe.length,
  };
}

// Mensagem consolidada (HTML do Telegram). null quando não há pendência —
// o job não manda nada nesse caso.
function textoTelegram(r) {
  if (!r || !r.total) return null;
  const corta = (itens, fmt) => {
    const vis = itens.slice(0, MAX_DIAS_POR_LOJA).map(fmt).join(', ');
    return itens.length > MAX_DIAS_POR_LOJA ? `${vis} +${itens.length - MAX_DIAS_POR_LOJA} dia(s)` : vis;
  };
  const L = ['⚠️ <b>Importação Metrizap pendente</b>',
    `Inteligência de Vendas e Pareto ficam incompletos até corrigir (conferido ${ddmm(r.de)} a ${ddmm(r.ate)}).`];

  if (r.atrasadas.length) {
    L.push('', '📭 <b>Dias não importados</b>');
    const grupos = new Map(); // lojas com a mesma lista de dias numa linha só
    r.atrasadas.forEach(a => {
      const k = a.dias.length > MAX_DIAS_POR_LOJA ? `desde ${ddmm(a.ultimo)} (${a.dias.length} dias)` : faixas(a.dias);
      (grupos.get(k) || grupos.set(k, []).get(k)).push(a.loja);
    });
    const todas = grupos.size === 1 && r.atrasadas.length === r.lojas_com_dados && r.lojas_com_dados > 1;
    grupos.forEach((ls, k) => L.push(`• ${todas ? 'Todas as lojas' : ls.map(escHtml).join(', ')}: <b>${k}</b>`));
    L.push('<i>Se a loja não vendeu no dia, pode ignorar.</i>');
  }
  if (r.sem_detalhe.length) {
    L.push('', '🧾 <b>Falta o detalhe por venda</b> (está no Vendas & Custos, não em Vendas Detalhadas — reimporte o dia)');
    r.sem_detalhe.forEach(s => L.push(`• ${escHtml(s.loja)}: ${corta(s.dias, d => `${ddmm(d.date)} (${d.parcial ? 'faltam ' : ''}${BRL(d.valor)})`)}`));
  }
  if (r.so_no_detalhe.length) {
    L.push('', '🔎 <b>Detalhe maior que o resumo</b> (venda duplicada ou resumo desatualizado — conferir)');
    r.so_no_detalhe.forEach(s => L.push(`• ${escHtml(s.loja)}: ${corta(s.dias, d => `${ddmm(d.date)} (+${BRL(d.valor)})`)}`));
  }
  L.push('', '👉 Financeiro → Vendas & Custos → Importar Metrizap');
  return L.join('\n');
}

module.exports = { verificarImportacao, textoTelegram, faixas, somaDias, JANELA_DIAS };
