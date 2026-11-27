const test = require('node:test');
const assert = require('node:assert');
const { eventoFull, textoAvisoFull, textoResumoFull } = require('../src/fullMonitor');

test('evento: saiu do Full e zerou no Full', () => {
  assert.strictEqual(eventoFull({ prevTipo: 'fulfillment', novoTipo: 'xd_drop_off', prevQtd: 10, novaQtd: 10 }), 'saiu_full');
  assert.strictEqual(eventoFull({ prevTipo: 'fulfillment', novoTipo: 'fulfillment', prevQtd: 3, novaQtd: 0 }), 'zerou_full');
  assert.strictEqual(eventoFull({ prevTipo: null, novoTipo: 'fulfillment', prevQtd: null, novaQtd: 0 }), 'zerou_full');
  assert.strictEqual(eventoFull({ prevTipo: 'xd_drop_off', novoTipo: 'fulfillment', prevQtd: 0, novaQtd: 20 }), 'entrou_full');
});

test('evento: sem aviso repetido nem fora do Full', () => {
  assert.strictEqual(eventoFull({ prevTipo: 'fulfillment', novoTipo: 'fulfillment', prevQtd: 0, novaQtd: 0 }), null); // já estava zerado
  assert.strictEqual(eventoFull({ prevTipo: 'xd_drop_off', novoTipo: 'xd_drop_off', prevQtd: 5, novaQtd: 0 }), null); // não é Full
  assert.strictEqual(eventoFull({ prevTipo: 'fulfillment', novoTipo: null, prevQtd: 5, novaQtd: 5 }), null);          // logística desconhecida
  assert.strictEqual(eventoFull({ prevTipo: null, novoTipo: 'fulfillment', prevQtd: null, novaQtd: 8 }), null);
});

test('textos do Telegram', () => {
  const s = textoAvisoFull('saiu_full', { titulo: 'Kit <Cinta>', loja: 'UNIFULL', itemId: 'MLB1', novoTipo: 'self_service', vendas30d: 45 });
  assert.match(s, /SAIU do Full/); assert.match(s, /Full → <b>Flex<\/b>/); assert.match(s, /~1,5\/dia/); assert.match(s, /Kit &lt;Cinta&gt;/);
  assert.match(textoAvisoFull('zerou_full', { titulo: 'X', loja: 'L', itemId: 'MLB2' }), /ZERADO no Full/);
  assert.strictEqual(textoResumoFull({}), '');
  const r = textoResumoFull({ zerados: [{ titulo: 'A', loja: 'L', vendas30d: 30 }], saidas: [{ titulo: 'B', loja: 'L', novoTipo: 'xd_drop_off' }] });
  assert.match(r, /Estoque zerado no Full \(1\)/); assert.match(r, /Saíram do Full nas últimas 24h \(1\)/); assert.match(r, /agora Mercado Envios/);
  assert.match(textoResumoFull({ entradas: [{ titulo: 'C', loja: 'L' }] }), /Entraram no Full nas últimas 24h \(1\)/);
});
