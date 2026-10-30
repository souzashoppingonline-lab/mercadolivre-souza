const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
// ranking.js puxa pool/hub/notify — stub pra testar só a função pura.
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (/db\/pool$|ws\/hub$|\/notify$/.test(req)) return {};
  return orig.apply(this, arguments);
};
const { sugerirEstagio } = require('../src/ranking');
Module._load = orig;

test('sugestão de estágio para anúncio fora do Rankeamento', () => {
  assert.equal(sugerirEstagio({ vendas30: 3, catalogo: true }).fase, 'catalogo');
  assert.equal(sugerirEstagio({ vendas30: 2, vendas30Ant: 10 }).fase, 'recuperacao');
  assert.match(sugerirEstagio({ vendas30: 2, vendas30Ant: 10 }).motivo, /caíram de 10 para 2/);
  assert.equal(sugerirEstagio({ vendas30: 12, vendas30Ant: 8 }).fase, 'ranqueado');
  assert.equal(sugerirEstagio({ vendas30: 1, vendas30Ant: 0 }).fase, 'rankeando');
  assert.equal(sugerirEstagio({ vendas30: 4, vendas30Ant: 4 }).fase, 'rankeando'); // base anterior < 5 não vira recuperação
});
