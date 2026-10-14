// Testes do Princípio de Pareto (server/src/pareto.js): ordenação, percentuais,
// corte de 80%, casos sem faturamento, parcela não atribuída e venda duplicada
// entre lojas. Puros — não precisam de banco. Rodar: `npm test` (pasta server/).
const { test } = require('node:test');
const assert = require('node:assert');
const { calcularPareto, deduplicarEntreLojas } = require('../src/pareto');

const L = (item_id, faturamento, extra = {}) => ({ store_id: 'S1', item_id, faturamento, quantidade: 1, produto: 'Anúncio ' + item_id, marketplace: 'Mercado Livre', ...extra });

test('ordena por faturamento decrescente (empate desempata pelo item_id)', () => {
  const r = calcularPareto([L('B', 50), L('A', 300), L('C', 50), L('D', 100)]);
  assert.deepStrictEqual(r.anuncios.map(a => a.item_id), ['A', 'D', 'B', 'C']);
  assert.deepStrictEqual(r.anuncios.map(a => a.posicao), [1, 2, 3, 4]);
});

test('participação individual e acumulada; acumulado termina em 100%', () => {
  const r = calcularPareto([L('A', 600), L('B', 300), L('C', 100)]);
  assert.deepStrictEqual(r.anuncios.map(a => a.pct), [60, 30, 10]);
  assert.deepStrictEqual(r.anuncios.map(a => a.pct_acum), [60, 90, 100]);
  assert.strictEqual(r.faturamento_total, 1000);
});

test('corte de 80%: inclui o anúncio que ULTRAPASSA 80% e não reduz o resultado', () => {
  const r = calcularPareto([L('A', 600), L('B', 300), L('C', 100)]);
  // 60% não basta; A+B = 90% → B entra (ultrapassa), C fica fora.
  assert.deepStrictEqual(r.anuncios.map(a => a.pareto), [true, true, false]);
  assert.strictEqual(r.anuncios_pareto, 2);
  assert.strictEqual(r.pct_receita_pareto, 90);
  assert.strictEqual(r.faturamento_pareto, 900);
  assert.strictEqual(r.faturamento_demais, 100);
  assert.strictEqual(r.pct_anuncios_pareto, 66.67);
});

test('corte de 80%: para exatamente quando o acumulado é 80%', () => {
  const r = calcularPareto([L('A', 500), L('B', 300), L('C', 150), L('D', 50)]);
  assert.deepStrictEqual(r.anuncios.map(a => a.pareto), [true, true, false, false]);
  assert.strictEqual(r.pct_receita_pareto, 80);
});

test('não assume 20/80: resultado real (um anúncio sozinho pode passar de 80%)', () => {
  const r = calcularPareto([L('A', 950), L('B', 30), L('C', 20)]);
  assert.strictEqual(r.anuncios_pareto, 1);
  assert.strictEqual(r.pct_anuncios_pareto, 33.33);
  assert.strictEqual(r.pct_receita_pareto, 95);
});

test('centavos: soma de 0,1 + 0,2 + … não vira 79,999% e não muda o conjunto', () => {
  const rows = []; for (let i = 0; i < 10; i++) rows.push(L('X' + i, 0.1));
  const r = calcularPareto(rows);
  assert.strictEqual(r.faturamento_total, 1);
  assert.strictEqual(r.anuncios_pareto, 8); // 8 × 10% = 80% exato
  assert.strictEqual(r.anuncios[7].pct_acum, 80);
});

test('sem faturamento positivo: estado vazio, sem divisão por zero', () => {
  for (const rows of [[], [L('A', 0)], [L('A', 0), L('B', 0)]]) {
    const r = calcularPareto(rows);
    assert.strictEqual(r.vazio, true);
    assert.strictEqual(r.total_anuncios, 0);
    assert.strictEqual(r.pct_anuncios_pareto, 0);
    assert.deepStrictEqual(r.anuncios, []);
    assert.ok(!JSON.stringify(r).includes('NaN') && !JSON.stringify(r).includes('Infinity'));
  }
});

test('anúncio com faturamento 0 não conta como "anúncio com vendas"', () => {
  const r = calcularPareto([L('A', 100), L('Z', 0)]);
  assert.strictEqual(r.total_anuncios, 1);
  assert.strictEqual(r.anuncios_sem_receita, 1);
});

test('consolida o mesmo anúncio (várias vendas e SKUs) e usa o 1º título visto', () => {
  const r = calcularPareto([
    L('A', 100, { sku: 'S-1', produto: 'Título novo', quantidade: 2, link_anuncio: 'https://x/A' }),
    L('A', 50, { sku: 'S-2', produto: 'Título antigo', quantidade: 3 }),
    L('B', 40),
  ]);
  const a = r.anuncios[0];
  assert.strictEqual(a.faturamento, 150);
  assert.strictEqual(a.unidades, 5);
  assert.strictEqual(a.vendas, 2);
  assert.deepStrictEqual(a.skus, ['S-1', 'S-2']);
  assert.strictEqual(a.titulo, 'Título novo');
  assert.strictEqual(a.link, 'https://x/A');
});

test('mesmo item_id em lojas diferentes = anúncios diferentes', () => {
  const r = calcularPareto([L('A', 100, { store_id: 'S1' }), L('A', 100, { store_id: 'S2' })]);
  assert.strictEqual(r.total_anuncios, 2);
});

test('venda sem anúncio (item_id vazio) fica fora do ranking e é sinalizada', () => {
  const r = calcularPareto([L('A', 100), L('', 40), L(null, 10)]);
  assert.strictEqual(r.faturamento_total, 100);
  assert.deepStrictEqual(r.nao_atribuido, { faturamento: 50, linhas: 2 });
});

test('venda importada em 2 lojas conta uma vez, na loja do marketplace certo', () => {
  const rows = [
    { store_id: 'RSOUZA', marketplace: 'Mercado Livre', pedido: 'p1', item_id: 'MLB1', faturamento: 10 },
    { store_id: 'RSOUZA', marketplace: 'Mercado Livre', pedido: 'p2', item_id: 'MLB2', faturamento: 10 },
    { store_id: 'RSOUZA', marketplace: 'Shopee', pedido: 'X9', item_id: '239', sku: 'K', faturamento: 72.99 },
    { store_id: 'SHOPEE_RS', marketplace: 'Shopee', pedido: 'X9', item_id: '239', sku: 'K', faturamento: 72.99 },
    { store_id: 'SHOPEE_RS', marketplace: 'Shopee', pedido: 'X8', item_id: '240', faturamento: 5 },
  ];
  const d = deduplicarEntreLojas(rows);
  assert.strictEqual(d.rows.length, 4);
  assert.strictEqual(d.removidas.length, 1);
  assert.strictEqual(d.removidas[0].store_id, 'RSOUZA');
  // pedido igual em lojas e anúncios diferentes NÃO é duplicata
  const d2 = deduplicarEntreLojas([
    { store_id: 'A', marketplace: 'ML', pedido: 'p', item_id: '1', faturamento: 1 },
    { store_id: 'B', marketplace: 'ML', pedido: 'p', item_id: '2', faturamento: 1 },
  ]);
  assert.strictEqual(d2.removidas.length, 0);
});

test('conciliação com o Vendas & Custos: dia sem detalhe, dia só no detalhe e fechamento', () => {
  const { conciliarComResumoDiario } = require('../src/pareto');
  const resumo = [
    { store_id: 'TT', date: '2026-10-02', gross_revenue: 333.28 },  // sem detalhe nenhum
    { store_id: 'UN', date: '2026-10-01', gross_revenue: 7327.36 }, // detalhe tem 159,96 a mais
    { store_id: 'RS', date: '2026-10-02', gross_revenue: 100 },     // bate
  ];
  const detalhe = [
    { store_id: 'UN', date: '2026-10-01', faturamento: 7400 }, { store_id: 'UN', date: '2026-10-01', faturamento: 87.32 },
    { store_id: 'RS', date: '2026-10-02', faturamento: 100.01 },     // diferença de 1 centavo = arredondamento
  ];
  const c = conciliarComResumoDiario(resumo, detalhe);
  assert.strictEqual(c.faturamento, 7760.64);
  assert.deepStrictEqual(c.sem_detalhe, { faturamento: 333.28, dias: [{ store_id: 'TT', date: '2026-10-02', valor: 333.28, tem_detalhe: false }] });
  assert.strictEqual(c.so_no_detalhe.faturamento, 159.96);
  const somaDetalhe = 7400 + 87.32 + 100.01;
  assert.strictEqual(Math.round((c.faturamento - c.sem_detalhe.faturamento + c.so_no_detalhe.faturamento) * 100) / 100, Math.round((somaDetalhe - 0.01) * 100) / 100);
});
