const test = require('node:test');
const assert = require('node:assert');
const { linhaRitmo, textoCobertura, linhaConversao, linhaPromocao } = require('../src/vendaInfo');

test('ritmo do anúncio', () => {
  assert.match(linhaRitmo({ hoje: 3, d7: 21 }), /3ª venda<\/b> deste anúncio hoje · 21 nos últimos 7 dias/);
  assert.strictEqual(linhaRitmo({ hoje: 0, d7: 5 }), '');
});

test('cobertura do estoque em dias', () => {
  // 30 un em 30 dias = 1/dia; 14 em estoque → ~14 dias
  assert.match(textoCobertura({ estoque: 14, unidades: 30, diasJanela: 30 }), /~14 dias/);
  // anúncio novo: 10 un em 5 dias = 2/dia → 6 em estoque = ~3 dias
  assert.match(textoCobertura({ estoque: 6, unidades: 10, diasJanela: 5 }), /~3 dias/);
  assert.match(textoCobertura({ estoque: 1, unidades: 60, diasJanela: 30 }), /acaba hoje/);
  assert.match(textoCobertura({ estoque: 500, unidades: 3, diasJanela: 30 }), /mais de 90 dias/);
  assert.strictEqual(textoCobertura({ estoque: 0, unidades: 10, diasJanela: 30 }), '');
  assert.strictEqual(textoCobertura({ estoque: 10, unidades: 0, diasJanela: 30 }), '');
});

test('conversão', () => {
  assert.strictEqual(linhaConversao({ visitas: 1240, pedidos30: 26 }), '👁️ Visitas 30 dias: 1.240 · conversão 2,1%');
  assert.strictEqual(linhaConversao({ visitas: null, pedidos30: 3 }), '');
  assert.strictEqual(linhaConversao({ visitas: 0, pedidos30: 3 }), '');
});

test('promoção', () => {
  assert.match(linhaPromocao({ unitPrice: 78.99, fullPrice: 92.9 }), /−15%<\/b> \(de R\$\s92,90\)/);
  assert.strictEqual(linhaPromocao({ unitPrice: 50, fullPrice: 50 }), '');
  assert.strictEqual(linhaPromocao({ unitPrice: 50, fullPrice: null }), '');
});
