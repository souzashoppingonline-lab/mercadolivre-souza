// Camada de cálculo financeiro DETERMINÍSTICA sobre o Supabase do módulo
// Financeiro — extraída das fórmulas que já rodavam só no <script> de
// pages/financeiro-despesas.html (DRE/break-even) e
// pages/financeiro-projecao-caixa.html (fluxo de caixa/projeção). MESMA
// fórmula, nunca duas versões (nunca duplicar cálculo financeiro — ver
// workflow.md). Consumida hoje pelo Agente Financeiro
// (server/src/ai/agenteFinanceiro.js + routes/agenteFinanceiro.js); as
// páginas do Financeiro continuam com sua própria cópia no frontend por ora
// (ver .claude/decisions.md — não foi mexido nesta tarefa pra não arriscar
// telas em produção sem necessidade).
//
// Nada aqui inventa número: se faltar dado (ex. Supabase Financeiro não
// configurado), a chamada propaga o erro — quem lê decide como mostrar.
const supa = require('./db/supabaseFin');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// ── Vendas & Custos (sales_entries) ─────────────────────────────────────────
const rev = (e) => Number(e.gross_revenue) || 0;
const custoVar = (e) =>
  (+e.marketplace_fees || 0) + (+e.subsidized_shipping || 0) + (+e.cogs || 0) +
  (+e.ads_ml || 0) + (+e.ads_external || 0) + (+e.tax || 0);

function salesAgg(sales, m, y) {
  const rows = sales.filter((e) => {
    if (!e.date) return false;
    const d = new Date(e.date + 'T00:00:00');
    return d.getMonth() + 1 === m && d.getFullYear() === y;
  });
  const a = { rec: 0, fees: 0, frete: 0, cmv: 0, adsMl: 0, adsEx: 0, tax: 0 };
  rows.forEach((r) => {
    a.rec += rev(r); a.fees += +r.marketplace_fees || 0; a.frete += +r.subsidized_shipping || 0;
    a.cmv += +r.cogs || 0; a.adsMl += +r.ads_ml || 0; a.adsEx += +r.ads_external || 0; a.tax += +r.tax || 0;
  });
  a.custoVar = a.fees + a.frete + a.cmv + a.adsMl + a.adsEx + a.tax;
  a.mc = a.rec - a.custoVar;
  a.mcPct = a.rec ? a.mc / a.rec : 0;
  return a;
}

// Margem de contribuição dos últimos 30 dias corridos — base do break-even,
// igual ao Readdy (independente do mês do DRE, sempre "agora").
function margin30(sales) {
  const hoje = new Date(), ini = new Date(hoje.getTime() - 30 * 86400000);
  const a = iso(ini), b = iso(hoje);
  let rec = 0, mc = 0;
  sales.forEach((e) => {
    const d = (e.date || '').slice(0, 10);
    if (d >= a && d <= b) { rec += rev(e); mc += rev(e) - custoVar(e); }
  });
  return rec ? mc / rec : 0;
}

// ── Despesas (expenses) ─────────────────────────────────────────────────────
function expTotals(expenses, m, y) {
  const list = expenses.filter((e) => Number(e.month) === m && Number(e.year) === y);
  let fixed = 0, oper = 0;
  list.forEach((e) => { const v = +e.value || 0; if (e.type === 'fixed') fixed += v; else oper += v; });
  return { fixed, oper, total: fixed + oper };
}

// DRE mensal + comparativo com o mês anterior + ponto de equilíbrio.
// Mesma fórmula de renderDre()/renderBe() em financeiro-despesas.html.
async function getDRE({ mes, ano } = {}) {
  const hoje = new Date();
  const m = Number(mes) || hoje.getMonth() + 1, y = Number(ano) || hoje.getFullYear();
  let mAnt = m - 1, yAnt = y; if (mAnt < 1) { mAnt = 12; yAnt = y - 1; }

  const [sales, expenses] = await Promise.all([
    supa.selectRows('sales_entries', 5000, 'date.desc'),
    supa.selectRows('expenses', 5000),
  ]);

  const a = salesAgg(sales, m, y), aAnt = salesAgg(sales, mAnt, yAnt);
  const et = expTotals(expenses, m, y), etAnt = expTotals(expenses, mAnt, yAnt);
  const lucroBruto = a.mc, lucroLiq = lucroBruto - et.total, margemLiq = a.rec ? (lucroLiq / a.rec) * 100 : 0;
  const lucroBrutoAnt = aAnt.mc, lucroLiqAnt = lucroBrutoAnt - etAnt.total;
  const margemLiqAnt = aAnt.rec ? (lucroLiqAnt / aAnt.rec) * 100 : 0;

  const mc30 = margin30(sales);
  const mcPctBe = mc30 > 0 ? mc30 : a.mcPct;
  const pontoEquilibrio = mcPctBe > 0 ? et.total / mcPctBe : null;

  return {
    mes: m, ano: y,
    receita_bruta: round2(a.rec),
    taxas_marketplace: round2(a.fees),
    frete_subsidiado: round2(a.frete),
    cmv: round2(a.cmv),
    ads_ml: round2(a.adsMl),
    ads_externos: round2(a.adsEx),
    imposto: round2(a.tax),
    margem_contribuicao: round2(lucroBruto),
    margem_contribuicao_pct: round2(a.mcPct * 100),
    despesas_fixas: round2(et.fixed),
    despesas_operacionais: round2(et.oper),
    despesas_total: round2(et.total),
    lucro_liquido: round2(lucroLiq),
    margem_liquida_pct: round2(margemLiq),
    ponto_equilibrio: pontoEquilibrio != null ? round2(pontoEquilibrio) : null,
    comparativo_mes_anterior: {
      mes: mAnt, ano: yAnt,
      receita_bruta: round2(aAnt.rec),
      lucro_liquido: round2(lucroLiqAnt),
      margem_liquida_pct: round2(margemLiqAnt),
    },
  };
}

// ── Fluxo de caixa & projeção ────────────────────────────────────────────────
// Mesma lógica de caixaAtual()/ultimoRecebivel()/mediaRecebiveis7()/
// mediaFluxo30()/buildDias() em financeiro-projecao-caixa.html — só sem o
// ajuste de tendência manual (0%) e sem os blocos que só fazem sentido na
// tela (gráfico, edição inline, seção anual).
function caixaAtual(entries) {
  return entries.reduce((s, e) => s + (e.type === 'income' ? (+e.value || 0) : -(+e.value || 0)), 0);
}

// Último dia que TEM recebível lançado — corte entre "real" e "projeção"
// (sem isso, um buraco no meio dos recebíveis já lançados seria preenchido
// com média, inventando dinheiro que não vai entrar).
function ultimoRecebivel(recv) {
  return recv.reduce((max, r) => { const k = (r.date || '').slice(0, 10); return k > max ? k : max; }, '');
}

// Média dos últimos 7 dias corridos de recebíveis, contados a partir do
// último dia lançado (não de hoje). Divide por 7 sempre — fim de semana sem
// recebimento faz parte da média semanal real.
function mediaRecebiveis7(recv) {
  const fim = ultimoRecebivel(recv);
  if (!fim) return 0;
  const ini = iso(addDays(new Date(fim + 'T00:00:00'), -6));
  const soma = recv.filter((r) => { const k = (r.date || '').slice(0, 10); return k >= ini && k <= fim; })
    .reduce((s, r) => s + (+r.value || 0), 0);
  return soma / 7;
}

function mediaFluxo30(entries) {
  const hoje = new Date(), ini = iso(addDays(hoje, -30));
  const inc = entries.filter((e) => e.type === 'income' && (e.date || '') >= ini).reduce((s, e) => s + (+e.value || 0), 0);
  return inc / 30;
}

// Base da projeção de entradas: média de 7d de recebíveis (padrão); cai pra
// média de 30d do fluxo só se não houver recebível nenhum lançado.
function mediaBase(recv, entries) {
  const m = mediaRecebiveis7(recv);
  if (m > 0) return m;
  return mediaFluxo30(entries);
}

function buildDias(dias, { entries, recv, boletos, parcelas, recorrentes }) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const media = mediaBase(recv, entries);
  const corte = ultimoRecebivel(recv);
  const arr = [];
  for (let i = 0; i <= dias; i++) {
    const d = addDays(hoje, i), k = iso(d);
    const recs = recv.filter((r) => !r.recebido && (r.date || '').slice(0, 10) === k);
    const recorr = recorrentes.filter((t) => t.active !== false && t.type === 'income' && Number(t.day_of_month) === d.getDate());
    const bols = boletos.filter((b) => b.status !== 'pago' && b.tipo !== 'cartao' && (b.date || '').slice(0, 10) === k);
    const parc = parcelas.filter((p) => p.status !== 'pago' && (p.data_vencimento || '').slice(0, 10) === k);
    const entReal = recs.reduce((s, r) => s + (+r.value || 0), 0) + recorr.reduce((s, t) => s + (+t.value || 0), 0);
    const temReal = recs.length || recorr.length;
    const entProj = (temReal || i === 0 || (corte && k <= corte)) ? 0 : media;
    const sai = bols.reduce((s, b) => s + (+b.value || 0), 0) + parc.reduce((s, p) => s + (+p.valor || 0), 0);
    arr.push({ data: k, ent: entReal + entProj, sai, temReal });
  }
  let saldo = caixaAtual(entries);
  arr.forEach((o) => { saldo += o.ent - o.sai; o.saldo = saldo; });
  return arr;
}

async function getFluxoProjecao({ dias } = {}) {
  const janela = Math.min(Math.max(Number(dias) || 30, 1), 60);
  const [entries, recv, boletos, parcelas, recorrentes] = await Promise.all([
    supa.selectRows('cash_flow_entries', 20000, 'date.desc'),
    supa.selectRows('receivables', 5000, 'date.asc'),
    supa.selectRows('boletos_mensais', 10000),
    supa.selectRows('parcelas_cartao', 10000),
    supa.selectRows('cash_flow_recurring', 2000),
  ]);
  const arr = buildDias(janela, { entries, recv, boletos, parcelas, recorrentes });
  const caixa = caixaAtual(entries);
  const totEnt = arr.slice(1).reduce((s, o) => s + o.ent, 0);
  const totSai = arr.slice(1).reduce((s, o) => s + o.sai, 0);
  const saldoFinal = arr[arr.length - 1].saldo;
  const idxNegativo = arr.findIndex((o) => o.saldo < 0);
  const venc7 = arr.slice(1, 8).reduce((s, o) => s + o.sai, 0);

  return {
    dias: janela,
    caixa_atual: round2(caixa),
    entradas_previstas: round2(totEnt),
    saidas_previstas: round2(totSai),
    saldo_projetado: round2(saldoFinal),
    media_diaria_entrada_projetada: round2(mediaBase(recv, entries)),
    fica_negativo_em_dias: idxNegativo > 0 ? idxNegativo : null,
    vencimentos_proximos_7d: round2(venc7),
    serie: arr.map((o) => ({ data: o.data, entrada: round2(o.ent), saida: round2(o.sai), saldo: round2(o.saldo) })),
  };
}

// ── Contas a pagar (boletos_mensais + parcelas_cartao) ──────────────────────
async function getContasAPagar() {
  const hoje = iso(new Date());
  const em7 = iso(addDays(new Date(), 7));
  const em30 = iso(addDays(new Date(), 30));
  const [boletos, parcelas] = await Promise.all([
    supa.selectRows('boletos_mensais', 10000),
    supa.selectRows('parcelas_cartao', 10000),
  ]);
  // Compra-mãe de cartão (tipo='cartao', is_origem) não é dívida em si — quem
  // representa cada parcela é parcelas_cartao (mesmo racional de modules.md,
  // "compras de cartão não aparecem como linha").
  const pendBoletos = boletos.filter((b) => b.status !== 'pago' && b.tipo !== 'cartao');
  const pendParcelas = parcelas.filter((p) => p.status !== 'pago');
  const itens = [
    ...pendBoletos.map((b) => ({
      origem: 'boleto', nome: b.name || b.category || 'Sem nome', empresa: b.empresa || null,
      categoria: b.category || null, data: (b.date || '').slice(0, 10), valor: +b.value || 0,
    })),
    ...pendParcelas.map((p) => ({
      origem: 'cartao', nome: `Parcela ${p.numero_parcela || ''}`.trim(), empresa: null,
      categoria: 'Cartão de Crédito', data: (p.data_vencimento || '').slice(0, 10), valor: +p.valor || 0,
    })),
  ];
  const vencidos = itens.filter((i) => i.data && i.data < hoje);
  const proximos7 = itens.filter((i) => i.data && i.data >= hoje && i.data <= em7);
  const proximos30 = itens.filter((i) => i.data && i.data >= hoje && i.data <= em30);
  const soma = (l) => round2(l.reduce((s, i) => s + i.valor, 0));
  const porEmpresa = () => {
    const by = {};
    itens.forEach((i) => { const k = i.empresa || 'Sem empresa'; by[k] = (by[k] || 0) + i.valor; });
    return Object.entries(by).map(([empresa, total]) => ({ empresa, total: round2(total) })).sort((a, b) => b.total - a.total);
  };

  return {
    total_pendente: soma(itens), qtd_pendente: itens.length,
    vencidos: { total: soma(vencidos), qtd: vencidos.length, itens: vencidos.slice(0, 20) },
    proximos_7d: { total: soma(proximos7), qtd: proximos7.length, itens: proximos7.slice(0, 20) },
    proximos_30d: { total: soma(proximos30), qtd: proximos30.length },
    por_empresa: porEmpresa(),
  };
}

// ── Fechamento Mensal (monthly_closing) ─────────────────────────────────────
// Reusa salesAgg/expTotals — MESMA fórmula de getDRE() acima, nunca uma 3ª
// cópia (a página financeiro-dre.html já tem sua própria cópia no frontend,
// como financeiro-despesas.html/financeiro-projecao-caixa.html — ver
// decisions.md; a página nova de Fechamento Mensal é a primeira a ler daqui
// em vez de recalcular no <script>, de propósito). Serve tanto a PRÉVIA ao
// vivo (mês ainda open/in_progress — números mudam se alguém lançar uma
// venda/despesa depois) quanto os números gravados no snapshot de
// monthly_closing ao finalizar (mesma função, chamada de novo na hora de
// fechar — nunca duas fórmulas).
function cashFlowMes(entries, m, y) {
  const rows = entries.filter((e) => {
    const d = (e.date || '').slice(0, 10); if (!d) return false;
    const dt = new Date(d + 'T00:00:00'); return dt.getMonth() + 1 === m && dt.getFullYear() === y;
  });
  let inSum = 0, outSum = 0;
  rows.forEach((e) => { const v = +e.value || 0; if (e.type === 'income') inSum += v; else outSum += v; });
  return { in: inSum, out: outSum, saldo: inSum - outSum };
}
function boletosMes(boletos, m, y) {
  const ref = `${y}-${String(m).padStart(2, '0')}`;
  const rows = boletos.filter((b) => b.mes_referencia === ref && b.tipo !== 'cartao');
  const pagos = rows.filter((b) => b.status === 'pago');
  const pend = rows.filter((b) => b.status !== 'pago');
  return {
    pagos_count: pagos.length, pagos_total: round2(pagos.reduce((s, b) => s + (+b.value || 0), 0)),
    pendentes_count: pend.length, pendentes_total: round2(pend.reduce((s, b) => s + (+b.value || 0), 0)),
    itens: rows.map((b) => ({
      nome: b.name || b.category || 'Sem nome', categoria: b.category || null, empresa: b.empresa || null,
      valor: round2(+b.value || 0), status: b.status, data: (b.date || '').slice(0, 10),
    })).sort((x, y2) => (x.data < y2.data ? 1 : -1)),
  };
}
function categoriasMes(expenses, cats, m, y) {
  const list = expenses.filter((e) => Number(e.month) === m && Number(e.year) === y);
  const nomeById = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const by = {};
  list.forEach((e) => { const nome = nomeById[e.category_id] || 'Sem categoria'; by[nome] = (by[nome] || 0) + (+e.value || 0); });
  const total = list.reduce((s, e) => s + (+e.value || 0), 0);
  return Object.entries(by).map(([categoria, valor]) => ({ categoria, valor: round2(valor), pct: total ? round2((valor / total) * 100) : 0 }))
    .sort((x, y2) => y2.valor - x.valor).slice(0, 10);
}

async function getFechamentoMensal({ mes, ano } = {}) {
  const hoje = new Date();
  const m = Number(mes) || hoje.getMonth() + 1, y = Number(ano) || hoje.getFullYear();
  let mAnt = m - 1, yAnt = y; if (mAnt < 1) { mAnt = 12; yAnt = y - 1; }

  const [sales, expenses, cats, cfEntries, boletos, goals, closings] = await Promise.all([
    supa.selectRows('sales_entries', 5000, 'date.desc'),
    supa.selectRows('expenses', 5000),
    supa.selectRows('expense_categories', 500),
    supa.selectRows('cash_flow_entries', 20000, 'date.desc'),
    supa.selectRows('boletos_mensais', 10000),
    supa.selectRows('monthly_goals', 500),
    supa.selectRows('monthly_closing', 500),
  ]);

  const a = salesAgg(sales, m, y), aAnt = salesAgg(sales, mAnt, yAnt);
  const et = expTotals(expenses, m, y);
  const lucroLiq = a.mc - et.total, netPct = a.rec ? (lucroLiq / a.rec) * 100 : 0;

  const cf = cashFlowMes(cfEntries, m, y);
  const bol = boletosMes(boletos, m, y);
  const cat = categoriasMes(expenses, cats, m, y);
  const meta = goals.find((g) => Number(g.month) === m && Number(g.year) === y);
  const closingAnt = closings.find((c) => Number(c.month) === mAnt && Number(c.year) === yAnt);
  const qtd = sales.filter((e) => {
    if (!e.date) return false; const d = new Date(e.date + 'T00:00:00'); return d.getMonth() + 1 === m && d.getFullYear() === y;
  }).reduce((s, e) => s + (+e.quantity_sales || 0), 0);

  return {
    mes: m, ano: y,
    revenue_gross: round2(a.rec), revenue_total: round2(a.rec),
    marketplace_fees: round2(a.fees), subsidized_shipping: round2(a.frete), cogs_total: round2(a.cmv),
    ads_ml: round2(a.adsMl), ads_external: round2(a.adsEx), ads_cost_total: round2(a.adsMl + a.adsEx),
    tax: round2(a.tax),
    contribution_margin: round2(a.mc), contribution_margin_pct: round2(a.mcPct * 100),
    fixed_costs_total: round2(et.fixed), variable_costs_total: round2(et.oper),
    lucro_liquido: round2(lucroLiq), net_pct: round2(netPct),
    total_sales: qtd, avg_ticket: qtd ? round2(a.rec / qtd) : 0,
    cash_flow_in: round2(cf.in), cash_flow_out: round2(cf.out), cash_flow_balance: round2(cf.saldo),
    boletos_paid_count: bol.pagos_count, boletos_paid_total: bol.pagos_total,
    boletos_pending_count: bol.pendentes_count, boletos_pending_total: bol.pendentes_total,
    boletos_itens: bol.itens,
    expense_categories_top: cat,
    meta: meta ? { valor: round2(+meta.goal_value || 0), atingido_pct: (+meta.goal_value) ? round2((a.rec / (+meta.goal_value)) * 100) : null } : null,
    comparativo_mes_anterior: {
      mes: mAnt, ano: yAnt,
      revenue_gross: round2(aAnt.rec),
      status: closingAnt ? closingAnt.status : null,
      lucro_liquido: closingAnt ? round2(+closingAnt.contribution_margin - (+closingAnt.fixed_costs_total || 0) - (+closingAnt.variable_costs_total || 0)) : null,
      net_pct: closingAnt ? ((closingAnt.dre_data && closingAnt.dre_data.net_pct != null) ? +closingAnt.dre_data.net_pct : null) : null,
    },
  };
}

// ── Vendas & Custos por período (pra cruzar com a margem real do ML) ───────
async function getSalesEntriesPeriodo({ dateFrom, dateTo }) {
  const sales = await supa.selectRows('sales_entries', 5000, 'date.desc');
  const rows = sales.filter((e) => { const d = (e.date || '').slice(0, 10); return d >= dateFrom && d <= dateTo; });
  let receita = 0, margem = 0;
  rows.forEach((r) => { receita += rev(r); margem += rev(r) - custoVar(r); });
  return {
    receita: round2(receita),
    margem: round2(margem),
    mc_pct: receita ? round2((margem / receita) * 100) : 0,
    dias_com_lancamento: rows.length,
  };
}

module.exports = { getDRE, getFluxoProjecao, getContasAPagar, getSalesEntriesPeriodo, getFechamentoMensal };
