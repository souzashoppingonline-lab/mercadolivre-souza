// Princípio de Pareto por anúncio — cálculo PURO (sem banco), usado por
// GET /api/bi/vendas/pareto (routes/biVendas.js) e pelos testes
// (test/pareto.test.js). Entrada: linhas de sales_entries_detail (detalhe do
// lançamento Metrizap) já SEM canceladas. Métrica: coluna `faturamento`
// (faturamento bruto da venda, mesma de Vendas Detalhadas / Inteligência de
// Vendas) — não é lucro nem receita líquida. Ver .claude/modules.md.
//
// Somas em CENTAVOS inteiros: evita que o acumulado vire 79,9999…% por erro de
// ponto flutuante e mude quem entra no conjunto de 80%.
const PARETO_CORTE_PCT = 80;

const centavos = v => Math.round((Number(v) || 0) * 100);
const reais = c => c / 100;
const r2 = n => Math.round(n * 100) / 100;

// A mesma venda (marketplace + pedido + anúncio + SKU) importada em mais de
// uma loja conta UMA vez. Fica na loja cujo marketplace predominante (mais
// linhas no conjunto) é o da venda; empate/nenhuma → a 1ª encontrada.
function deduplicarEntreLojas(rows) {
  const predominante = {};
  const contagem = {};
  rows.forEach(r => {
    const k = `${r.store_id}`;
    (contagem[k] = contagem[k] || {})[r.marketplace || ''] = (contagem[k][r.marketplace || ''] || 0) + 1;
  });
  Object.entries(contagem).forEach(([loja, mps]) => {
    predominante[loja] = Object.entries(mps).sort((a, b) => b[1] - a[1])[0][0];
  });
  const porVenda = new Map();
  rows.forEach(r => {
    const k = [r.marketplace || '', r.pedido || '', r.item_id || '', r.sku || ''].join('|');
    (porVenda.get(k) || porVenda.set(k, []).get(k)).push(r);
  });
  const manter = [], removidas = [];
  porVenda.forEach(lista => {
    const lojas = new Set(lista.map(r => String(r.store_id)));
    if (lojas.size <= 1 || !lista[0].pedido) { manter.push(...lista); return; }
    const certa = lista.find(r => predominante[String(r.store_id)] === (r.marketplace || '')) || lista[0];
    const lojaCerta = String(certa.store_id);
    lista.forEach(r => (String(r.store_id) === lojaCerta ? manter : removidas).push(r));
  });
  return { rows: manter, removidas };
}

// rows: já filtradas (período/loja, sem canceladas). Ordem de entrada define o
// título exibido quando o anúncio mudou de título: o 1º visto (o chamador
// passa por data desc → o mais recente).
function calcularPareto(rows, corte = PARETO_CORTE_PCT) {
  const anuncios = new Map();
  const naoAtribuido = { faturamento: 0, linhas: 0 };
  rows.forEach(r => {
    const itemId = String(r.item_id || '').trim();
    const c = centavos(r.faturamento);
    if (!itemId) { naoAtribuido.faturamento += c; naoAtribuido.linhas += 1; return; }
    const key = `${r.store_id}::${itemId}`;
    let a = anuncios.get(key);
    if (!a) {
      a = { store_id: r.store_id, item_id: itemId, marketplace: r.marketplace || null, titulo: r.produto || '(sem título)',
        skus: new Set(), link: null, unidades: 0, vendas: 0, c: 0 };
      anuncios.set(key, a);
    }
    if (r.sku) a.skus.add(String(r.sku));
    if (!a.link && r.link_anuncio) a.link = r.link_anuncio;
    a.unidades += Number(r.quantidade) || 0;
    a.vendas += 1;
    a.c += c;
  });

  const todos = [...anuncios.values()];
  const comReceita = todos.filter(a => a.c > 0)
    .sort((x, y) => y.c - x.c || String(x.item_id).localeCompare(String(y.item_id)));
  const semReceita = todos.length - comReceita.length;
  const totalC = comReceita.reduce((s, a) => s + a.c, 0);

  const base = {
    corte_pct: corte,
    nao_atribuido: { faturamento: reais(naoAtribuido.faturamento), linhas: naoAtribuido.linhas },
    anuncios_sem_receita: semReceita,
  };
  if (totalC <= 0) {
    return { ...base, vazio: true, faturamento_total: 0, total_anuncios: 0, anuncios_pareto: 0,
      pct_anuncios_pareto: 0, faturamento_pareto: 0, faturamento_demais: 0, pct_receita_pareto: 0, anuncios: [] };
  }

  let acumC = 0, paretoN = 0, paretoC = 0, atingiu = false;
  const lista = comReceita.map((a, i) => {
    acumC += a.c;
    const pareto = !atingiu;
    if (pareto) { paretoN += 1; paretoC += a.c; if (acumC * 100 >= corte * totalC) atingiu = true; }
    return {
      posicao: i + 1, store_id: a.store_id, item_id: a.item_id, marketplace: a.marketplace, titulo: a.titulo,
      skus: [...a.skus], link: a.link, unidades: a.unidades, vendas: a.vendas,
      faturamento: reais(a.c),
      pct: r2(a.c / totalC * 100),
      pct_acum: r2(acumC / totalC * 100),
      pareto,
    };
  });

  return {
    ...base, vazio: false,
    faturamento_total: reais(totalC),
    total_anuncios: lista.length,
    anuncios_pareto: paretoN,
    pct_anuncios_pareto: r2(paretoN / lista.length * 100),
    faturamento_pareto: reais(paretoC),
    faturamento_demais: reais(totalC - paretoC),
    pct_receita_pareto: r2(paretoC / totalC * 100),
    anuncios: lista,
  };
}

// Concilia com o Vendas & Custos (sales_entries = resumo diário por loja,
// gross_revenue, mesmo import Metrizap). Por loja+dia: o que está no resumo e
// NÃO tem detalhe por venda (dia não importado no detalhe) é faturamento sem
// anúncio conhecido → fica fora do Pareto e é sinalizado; o contrário (detalhe
// maior que o resumo) também é listado. resumo − sem_detalhe + so_no_detalhe =
// soma do detalhe usado no Pareto.
function conciliarComResumoDiario(resumo, detalhe) {
  const k = (s, d) => `${s}::${String(d || '').slice(0, 10)}`;
  const agg = new Map(), det = new Map();
  resumo.forEach(e => agg.set(k(e.store_id, e.date), (agg.get(k(e.store_id, e.date)) || 0) + centavos(e.gross_revenue)));
  detalhe.forEach(r => det.set(k(r.store_id, r.date), (det.get(k(r.store_id, r.date)) || 0) + centavos(r.faturamento)));
  const semDetalhe = [], soNoDetalhe = [];
  new Set([...agg.keys(), ...det.keys()]).forEach(chave => {
    const dif = (agg.get(chave) || 0) - (det.get(chave) || 0);
    if (Math.abs(dif) < 5) return; // < R$0,05: arredondamento
    const [store_id, date] = chave.split('::');
    (dif > 0 ? semDetalhe : soNoDetalhe).push({ store_id, date, valor: reais(Math.abs(dif)), tem_detalhe: det.has(chave) });
  });
  const ord = (a, b) => a.date.localeCompare(b.date) || String(a.store_id).localeCompare(String(b.store_id));
  const soma = l => r2(l.reduce((s, x) => s + x.valor, 0));
  return {
    faturamento: reais([...agg.values()].reduce((s, c) => s + c, 0)),
    sem_detalhe: { faturamento: soma(semDetalhe), dias: semDetalhe.sort(ord) },
    so_no_detalhe: { faturamento: soma(soNoDetalhe), dias: soNoDetalhe.sort(ord) },
  };
}

module.exports = { calcularPareto, deduplicarEntreLojas, conciliarComResumoDiario, PARETO_CORTE_PCT };
