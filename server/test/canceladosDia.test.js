const test = require('node:test');
const assert = require('node:assert');
const { textoCanceladaNaHora, SQL_UM } = require('../src/canceladosDia');

test('aviso na hora: venda de hoje, já bipada', () => {
  const t = textoCanceladaNaHora({ ml_id: '2000019804230176', mkt: 'ML', loja: 'UNIFULL_MULTIMERCADO', title: 'Secar Antimofo Desumidificador', quantity: 1,
    total_amount: 162.95, date_created: '2026-11-26T23:17:00Z', de_hoje: true, bipado: true, motivo: 'Comprador desistiu' }, 1234.5);
  assert.match(t, /Venda CANCELADA/); assert.match(t, /vendida hoje às 20:17/);
  assert.match(t, /R\$\s?162,95/); assert.match(t, /NÃO ENVIAR/); assert.match(t, /agora <b>R\$\s?1\.234,50/); assert.match(t, /Comprador desistiu/);
});

test('aviso na hora: venda de outro dia e Shopee', () => {
  const t = textoCanceladaNaHora({ ml_id: 'X1', mkt: 'SHOPEE', loja: 'Shopee UNIFULL', title: 'A', quantity: 2, total_amount: 50, date_created: '2026-11-20T15:00:00Z', de_hoje: false });
  assert.match(t, /Shopee/); assert.match(t, /Saiu do faturamento do dia 20\/11\/2026/); assert.doesNotMatch(t, /NÃO ENVIAR/);
});

test('SQL de 1 pedido filtra pelo id', () => {
  assert.match(SQL_UM, /o\.ml_id = \$1/); assert.doesNotMatch(SQL_UM, /updated_at >= h\.ini/);
});
