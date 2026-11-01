// Análise do Extrato Bancário (OFX) — números da tela (PURO — testado em
// test/ofxAnalise.test.js). A IA (routes/extratoOfx.js) só recebe ESTE
// resultado pra interpretar; nunca calcula número (regra do projeto).
// Ver .claude/extrato-ofx.md.
const { POR_ID } = require('./ofxCategorias');

const SALDO_BAIXO = 5000;          // alerta "saldo abaixo de R$ 5 mil" (business-rules.md)
const FORA_PADRAO_X = 3;           // saída > 3× a mediana da mesma contraparte
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b ? r2(((a - b) / Math.abs(b)) * 100) : null);
const fora = (c) => !!(POR_ID[c] && POR_ID[c].fora);
const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function porCategoria(lancs, sentido) {
  const m = {};
  lancs.filter((l) => (sentido === 'entrada' ? l.valor > 0 : l.valor < 0)).forEach((l) => {
    const c = l.categoria || 'sem_categoria';
    m[c] = m[c] || { categoria: c, total: 0, qtd: 0 };
    m[c].total += Math.abs(l.valor); m[c].qtd++;
  });
  const lista = Object.values(m);
  const base = lista.filter((x) => !fora(x.categoria)).reduce((a, x) => a + x.total, 0);
  return lista.map((x) => ({ ...x, total: r2(x.total), fora: fora(x.categoria), pct: fora(x.categoria) || !base ? null : r2((x.total / base) * 100),
    nome: POR_ID[x.categoria]?.nome || x.categoria, ico: POR_ID[x.categoria]?.ico || '❔' }))
    .sort((a, b) => (a.fora - b.fora) || b.total - a.total);
}

function agruparContraparte(lancs, sinal) {
  const m = {};
  lancs.filter((l) => (sinal > 0 ? l.valor > 0 : l.valor < 0) && !fora(l.categoria)).forEach((l) => {
    const k = l.contraparte_chave || l.contraparte;
    m[k] = m[k] || { chave: k, nome: l.contraparte, categoria: l.categoria, vezes: 0, total: 0 };
    m[k].vezes++; m[k].total += Math.abs(l.valor);
  });
  return Object.values(m).map((x) => ({ ...x, total: r2(x.total) })).sort((a, b) => b.total - a.total);
}

// lancs: lançamentos do mês ({id, data, valor (com sinal), categoria, contraparte, contraparte_chave, descricao, categoria_origem}).
// anteriores: lançamentos dos 3 meses anteriores (comparativo/recorrentes/fora do padrão).
// saldoRef: { valor, data } = saldo no fim de `data` (LEDGERBAL), ou null; lancsAposRef: lançamentos depois do fim do mês até saldoRef.data.
function resumoMes({ mes, lancs, anteriores = [], saldoRef = null, lancsAposRef = [] }) {
  const [y, m] = mes.split('-').map(Number);
  const ini = `${mes}-01`, fim = ymd(new Date(Date.UTC(y, m, 0)));
  const mesAnt = ymd(new Date(Date.UTC(y, m - 2, 1))).slice(0, 7);
  const conta = (ls, s) => r2(ls.filter((l) => (s > 0 ? l.valor > 0 : l.valor < 0) && !fora(l.categoria)).reduce((a, l) => a + Math.abs(l.valor), 0));
  const entradas = conta(lancs, 1), saidas = conta(lancs, -1);
  const ant = anteriores.filter((l) => ymd(l.data).startsWith(mesAnt));
  const entradasAnt = ant.length ? conta(ant, 1) : null, saidasAnt = ant.length ? conta(ant, -1) : null;

  const tarifas = lancs.filter((l) => l.categoria === 'tarifas' && l.valor < 0);
  const volume = lancs.reduce((a, l) => a + Math.abs(l.valor), 0);
  const tarifasTot = r2(tarifas.reduce((a, l) => a + Math.abs(l.valor), 0));

  // Saldo no fim de cada dia, de trás pra frente a partir do saldo do OFX.
  // saldo(d) = saldoRef − soma dos lançamentos depois de d até a data do saldoRef.
  const dias = [];
  const porDia = {};
  lancs.forEach((l) => { const d = ymd(l.data); porDia[d] = porDia[d] || { e: 0, s: 0, liq: 0 }; porDia[d].liq += l.valor; if (!fora(l.categoria)) { if (l.valor > 0) porDia[d].e += l.valor; else porDia[d].s += -l.valor; } });
  // Extrato que termina no meio do mês (saldoRef antes do fim): dias depois dele ficam sem saldo.
  const refD = saldoRef && saldoRef.valor != null ? ymd(saldoRef.data) : null;
  let saldo = refD && refD >= fim ? saldoRef.valor - lancsAposRef.reduce((a, l) => a + l.valor, 0) : null; // = saldo no fim do mês
  for (let d = new Date(fim + 'T12:00:00Z'); ymd(d) >= ini; d = new Date(d.getTime() - 86400000)) {
    const k = ymd(d), pd = porDia[k] || { e: 0, s: 0, liq: 0 };
    if (saldo == null && refD && refD === k) saldo = saldoRef.valor;
    dias.unshift({ data: k, entradas: r2(pd.e), saidas: r2(pd.s), saldo: saldo == null ? null : r2(saldo) });
    if (saldo != null) saldo -= pd.liq;
  }
  const comSaldo = dias.filter((d) => d.saldo != null);
  const menor = comSaldo.length ? comSaldo.reduce((a, d) => (d.saldo < a.saldo ? d : a)) : null;
  const maior = comSaldo.length ? comSaldo.reduce((a, d) => (d.saldo > a.saldo ? d : a)) : null;
  const maiorSaida = dias.reduce((a, d) => (d.saidas > (a ? a.saidas : 0) ? d : a), null);
  const maiorEntrada = dias.reduce((a, d) => (d.entradas > (a ? a.entradas : 0) ? d : a), null);

  // Destinatários (saídas) e origens (entradas) com comparação ao mês anterior.
  const antPorChave = Object.fromEntries(agruparContraparte(ant, -1).map((x) => [x.chave, x.total]));
  const destinatarios = agruparContraparte(lancs, -1).slice(0, 8).map((x) => ({ ...x, total_ant: antPorChave[x.chave] ?? null, var_pct: antPorChave[x.chave] ? pct(x.total, antPorChave[x.chave]) : null }));
  const origens = agruparContraparte(lancs, 1).slice(0, 6);

  // Recorrentes: mesma contraparte de saída em ≥ 3 dos 4 meses (este + 3 anteriores).
  const todos = [...anteriores, ...lancs].filter((l) => l.valor < 0 && !fora(l.categoria));
  const meses = {};
  todos.forEach((l) => { const k = l.contraparte_chave; meses[k] = meses[k] || { nome: l.contraparte, m: {}, dias: [], valores: [] }; meses[k].m[ymd(l.data).slice(0, 7)] = 1; meses[k].dias.push(Number(ymd(l.data).slice(8))); meses[k].valores.push(-l.valor); });
  const recorrentes = Object.entries(meses).filter(([, x]) => Object.keys(x.m).length >= 3)
    .map(([k, x]) => ({ chave: k, nome: x.nome, meses: Object.keys(x.m).length, dia: Math.round(mediana(x.dias)), valor_medio: r2(x.valores.reduce((a, v) => a + v, 0) / x.valores.length), no_mes: !!x.m[mes] }))
    .sort((a, b) => b.valor_medio - a.valor_medio).slice(0, 10);

  // Alertas
  const alertas = [];
  const dup = {};
  lancs.filter((l) => l.valor < 0 && !fora(l.categoria)).forEach((l) => { const k = `${ymd(l.data)}|${l.valor}|${l.contraparte_chave}`; (dup[k] = dup[k] || []).push(l); });
  Object.values(dup).filter((g) => g.length >= 2).forEach((g) => alertas.push({ tipo: 'duplicado', nivel: 'danger', data: ymd(g[0].data), valor: r2(-g[0].valor), vezes: g.length, nome: g[0].contraparte, ids: g.map((l) => l.id) }));
  const baixos = comSaldo.filter((d) => d.saldo < SALDO_BAIXO);
  if (baixos.length) alertas.push({ tipo: 'saldo_baixo', nivel: 'warning', limite: SALDO_BAIXO, dias: baixos.map((d) => d.data) });
  const hist = {};
  anteriores.filter((l) => l.valor < 0).forEach((l) => { (hist[l.contraparte_chave] = hist[l.contraparte_chave] || []).push(-l.valor); });
  lancs.filter((l) => l.valor < 0 && !fora(l.categoria)).forEach((l) => {
    const h = hist[l.contraparte_chave];
    if (h && h.length >= 3) { const md = mediana(h); if (md > 0 && -l.valor > md * FORA_PADRAO_X) alertas.push({ tipo: 'fora_padrao', nivel: 'warning', data: ymd(l.data), valor: r2(-l.valor), mediana: r2(md), nome: l.contraparte, id: l.id }); }
  });
  const autoEntre = lancs.filter((l) => l.categoria === 'entre_contas' && l.categoria_origem === 'auto');
  if (autoEntre.length) alertas.push({ tipo: 'confirmar_entre_contas', nivel: 'info', qtd: autoEntre.length, total: r2(autoEntre.reduce((a, l) => a + Math.abs(l.valor), 0)) });
  const semCat = lancs.filter((l) => !l.categoria || l.categoria === 'sem_categoria');
  if (semCat.length) alertas.push({ tipo: 'sem_categoria', nivel: 'info', qtd: semCat.length, total: r2(semCat.reduce((a, l) => a + Math.abs(l.valor), 0)) });

  return {
    mes, periodo: { ini, fim, lancamentos: lancs.length },
    totais: { entradas, saidas, resultado: r2(entradas - saidas), entradas_ant: entradasAnt, saidas_ant: saidasAnt, var_entradas_pct: entradasAnt != null ? pct(entradas, entradasAnt) : null, var_saidas_pct: saidasAnt != null ? pct(saidas, saidasAnt) : null },
    categorias: { entradas: porCategoria(lancs, 'entrada'), saidas: porCategoria(lancs, 'saida') },
    tarifas: { total: tarifasTot, qtd: tarifas.length, pct_volume: volume ? r2((tarifasTot / volume) * 100) : 0 },
    saldo: { inicial: comSaldo.length ? r2(comSaldo[0].saldo - (porDia[comSaldo[0].data]?.liq || 0)) : null, final: comSaldo.length ? comSaldo[comSaldo.length - 1].saldo : null, menor, maior, dias },
    maior_saida_dia: maiorSaida && maiorSaida.saidas ? maiorSaida : null,
    maior_entrada_dia: maiorEntrada && maiorEntrada.entradas ? maiorEntrada : null,
    destinatarios, origens, recorrentes, alertas,
  };
}

module.exports = { resumoMes, SALDO_BAIXO };
