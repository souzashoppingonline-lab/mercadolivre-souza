// js/dividasDia.js no Node (o worker.js reusa o cálculo da página pro push das
// 07:00): textoNotificacao a partir do MESMO calcular() da página.
const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../../js/dividasDia');

const B = (id, name, date, value, status = 'pendente') => ({ id, name, date, value, status, tipo: 'boleto', empresa: 'UNIFULL' });

test('carrega no Node sem window e expõe o mesmo API da página', () => {
  assert.strictEqual(typeof D.calcular, 'function');
  assert.strictEqual(typeof D.textoNotificacao, 'function');
});

test('vencem hoje + atrasadas: título com quantidade e total, corpo com nomes e atrasadas', () => {
  const r = D.calcular({ hoje: '2026-10-16', boletos: [
    B('1', 'BOLETO MARTINS', '2026-10-16', 1000), B('2', 'QUATREE', '2026-10-16', 500.5), B('3', 'SANOL', '2026-10-16', 10),
    B('4', 'ALUGUEL', '2026-10-10', 2000), B('5', 'PAGO', '2026-10-16', 99, 'pago'), B('6', 'FUTURO', '2026-10-17', 1),
  ] });
  const n = D.textoNotificacao(r);
  assert.match(n.title, /^💸 3 contas vencem hoje — R\$\s1\.510,50$/);
  assert.match(n.body, /BOLETO MARTINS, QUATREE e \+1/);
  assert.match(n.body, /⚠️ 1 atrasada \(R\$\s2\.000,00\)/);
});

test('só atrasadas; uma conta só no singular; nada a pagar → null', () => {
  assert.match(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('4', 'ALUGUEL', '2026-10-10', 2000)] })).title, /^⚠️ 1 conta atrasada — /);
  assert.match(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('1', 'LUZ', '2026-10-16', 80)] })).title, /^💸 1 conta vence hoje/);
  assert.strictEqual(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('6', 'FUTURO', '2026-10-17', 1)] })), null);
});
