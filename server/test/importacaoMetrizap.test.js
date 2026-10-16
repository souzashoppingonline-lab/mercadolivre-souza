// Testes do alerta "dia sem importação" (server/src/importacaoMetrizap.js):
// dias atrasados por loja, resumo sem detalhe, detalhe maior que o resumo,
// janela, lojas inativas e o texto do Telegram. Puros — não precisam de banco.
const { test } = require('node:test');
const assert = require('node:assert');
const { verificarImportacao, textoTelegram, faixas } = require('../src/importacaoMetrizap');

const LOJAS = [{ id: 'UN', name: 'UNIFULL' }, { id: 'TT', name: 'TIKTOK SHOP UNIFULL' }, { id: 'SP', name: 'SHOPEE' }];
const res = (store_id, date, v) => ({ store_id, date, gross_revenue: v });
const det = (store_id, date, v) => ({ store_id, date, faturamento: v });

test('faixas: dias seguidos viram "a", soltos ficam separados', () => {
  assert.strictEqual(faixas(['2026-10-15', '2026-10-13', '2026-10-14', '2026-10-18']), '13/10 a 15/10, 18/10');
  assert.strictEqual(faixas(['2026-09-30', '2026-10-01']), '30/09 a 01/10');
  assert.strictEqual(faixas(['2026-10-02']), '02/10');
});

test('loja em dia não aparece; loja parada aparece com os dias até ontem', () => {
  const r = verificarImportacao({
    lojas: LOJAS, ontem: '2026-10-15',
    resumo: [res('UN', '2026-10-15', 100), res('TT', '2026-10-12', 50)],
    detalhe: [det('UN', '2026-10-15', 100), det('TT', '2026-10-12', 50)],
  });
  assert.deepStrictEqual(r.atrasadas.map(a => [a.loja, a.dias]), [['TIKTOK SHOP UNIFULL', ['2026-10-13', '2026-10-14', '2026-10-15']]]);
  assert.strictEqual(r.sem_detalhe.length, 0);
});

test('buraco no meio do período NÃO é atraso (pode ser dia sem venda)', () => {
  const r = verificarImportacao({
    lojas: LOJAS, ontem: '2026-10-15',
    resumo: [res('SP', '2026-10-10', 10), res('SP', '2026-10-15', 10)],
    detalhe: [det('SP', '2026-10-10', 10), det('SP', '2026-10-15', 10)],
  });
  assert.strictEqual(r.total, 0);
  assert.strictEqual(textoTelegram(r), null);
});

test('resumo sem detalhe (todo ou parcial) e detalhe maior que o resumo', () => {
  const r = verificarImportacao({
    lojas: LOJAS, ontem: '2026-10-15',
    resumo: [res('TT', '2026-10-14', 333.28), res('TT', '2026-10-15', 100), res('UN', '2026-10-15', 7327.36), res('SP', '2026-10-15', 50), res('SP', '2026-10-01', 9)],
    detalhe: [det('TT', '2026-10-15', 60), det('UN', '2026-10-15', 7487.32), det('SP', '2026-10-15', 50.01), det('SP', '2026-10-01', 9)],
  });
  assert.deepStrictEqual(r.sem_detalhe, [{ store_id: 'TT', loja: 'TIKTOK SHOP UNIFULL', valor: 373.28,
    dias: [{ date: '2026-10-14', valor: 333.28, parcial: false }, { date: '2026-10-15', valor: 40, parcial: true }] }]);
  assert.deepStrictEqual(r.so_no_detalhe.map(s => [s.loja, s.valor]), [['UNIFULL', 159.96]]);
  assert.strictEqual(r.atrasadas.length, 0); // SHOPEE: 1 centavo é arredondamento
});

test('janela: fora dos últimos N dias é ignorado; loja inativa é ignorada', () => {
  const r = verificarImportacao({
    lojas: LOJAS.filter(l => l.id !== 'SP'), ontem: '2026-10-15', janelaDias: 7,
    resumo: [res('UN', '2026-10-01', 999), res('UN', '2026-10-15', 1), res('SP', '2026-10-12', 5)],
    detalhe: [det('UN', '2026-10-15', 1)],
  });
  assert.strictEqual(r.de, '2026-10-09');
  assert.strictEqual(r.total, 0);
});

test('texto: todas as lojas com os mesmos dias numa linha; nomes escapados', () => {
  const r = verificarImportacao({
    lojas: [...LOJAS, { id: 'X', name: 'A&B <loja>' }], ontem: '2026-10-15',
    resumo: [res('UN', '2026-10-12', 1), res('TT', '2026-10-12', 1), res('SP', '2026-10-12', 1), res('X', '2026-10-12', 1)],
    detalhe: [det('UN', '2026-10-12', 1), det('TT', '2026-10-12', 1), det('SP', '2026-10-12', 1), det('X', '2026-10-12', 1)],
  });
  const t = textoTelegram(r);
  assert.match(t, /Todas as lojas: <b>13\/10 a 15\/10<\/b>/);
  const r2 = verificarImportacao({
    lojas: [...LOJAS, { id: 'X', name: 'A&B <loja>' }], ontem: '2026-10-15',
    resumo: [res('UN', '2026-10-15', 1), res('X', '2026-10-14', 1)], detalhe: [det('UN', '2026-10-15', 1), det('X', '2026-10-14', 1)],
  });
  assert.match(textoTelegram(r2), /A&amp;B &lt;loja&gt;: <b>15\/10<\/b>/);
  assert.ok(textoTelegram(r2).length < 4096);
});

test('dias anteriores ao 1º detalhe importado não cobram detalhe (antes do detalhe existir)', () => {
  const r = verificarImportacao({
    lojas: LOJAS, ontem: '2026-10-15',
    resumo: [res('UN', '2026-09-20', 4000), res('UN', '2026-10-01', 10), res('UN', '2026-10-15', 5), res('TT', '2026-10-15', 7)],
    detalhe: [det('UN', '2026-10-01', 10), det('UN', '2026-10-15', 5)],
  });
  assert.strictEqual(r.inicio_detalhe, '2026-10-01');
  assert.deepStrictEqual(r.sem_detalhe.map(s => [s.loja, s.dias.map(d => d.date)]), [['TIKTOK SHOP UNIFULL', ['2026-10-15']]]);
  // sem nenhum detalhe na janela, não há o que conciliar
  assert.strictEqual(verificarImportacao({ lojas: LOJAS, ontem: '2026-10-15', resumo: [res('UN', '2026-10-15', 5)] }).sem_detalhe.length, 0);
});
