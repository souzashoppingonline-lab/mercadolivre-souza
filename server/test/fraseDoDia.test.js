const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
let respostas = [], configurada = true;
const orig = Module._load;
Module._load = function (req) {
  if (/db\/pool$/.test(req)) return {};
  if (/ai\/llm$/.test(req)) return { isConfigured: () => configurada, complete: async () => respostas.shift() };
  return orig.apply(this, arguments);
};
const { gerar, RESERVA } = require('../src/fraseDoDia');
Module._load = orig;

test('IA: frase repetida (mesmo com acento/pontuação diferente) é descartada e pede de novo', async () => {
  respostas = ['Hoje é dia de bater o recorde!', '"Capricha na embalagem que o cliente volta."'];
  const r = await gerar('2026-10-30', [{ frase: 'hoje e dia de bater o recorde' }]);
  assert.equal(r.origem, 'ia');
  assert.equal(r.frase, 'Capricha na embalagem que o cliente volta.');
});

test('sem IA: usa a reserva, sempre a próxima ainda não usada', async () => {
  configurada = false;
  const r = await gerar('2026-10-30', [{ frase: RESERVA[0] }, { frase: RESERVA[1] }]);
  assert.equal(r.origem, 'reserva');
  assert.equal(r.frase, RESERVA[2]);
  assert.equal(await gerar('2026-10-30', RESERVA.map(f => ({ frase: f }))), null);
});
