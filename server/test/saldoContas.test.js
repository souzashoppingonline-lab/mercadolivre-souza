// Saldo disponível a partir do saldo informado (server/src/saldoContas.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { calcularSaldo } = require('../src/saldoContas');

const INF = { valor: '5000.00', informado_em: '2026-10-23T11:00:00Z', informado_por: 'ana' };
test('desconta saídas e soma entradas lançadas DEPOIS do informe, na conta', () => {
  const r = calcularSaldo(INF, [
    { type: 'expense', value: 1219.02, created_at: '2026-10-23T12:00:00Z' },
    { type: 'expense', value: 300, created_at: '2026-10-23T10:59:59Z' },   // antes do informe: já estava no saldo
    { type: 'income', value: 100.5, created_at: '2026-10-23T13:00:00Z' },
  ], '2026-10-23T14:00:00Z');
  assert.deepStrictEqual([r.informado, r.saidas, r.entradas, r.disponivel, r.movimentos, r.desatualizado], [5000, 1219.02, 100.5, 3881.48, 2, false]);
});
test('sem saldo informado → null; informe com mais de 24h → desatualizado', () => {
  assert.strictEqual(calcularSaldo(null, []).disponivel, null);
  assert.strictEqual(calcularSaldo(INF, [], '2026-10-24T11:30:00Z').desatualizado, true);
  assert.strictEqual(calcularSaldo(INF, [], '2026-10-24T10:30:00Z').desatualizado, false);
});
test('saldo pode ficar negativo (cheque especial)', () => {
  assert.strictEqual(calcularSaldo({ ...INF, valor: 100 }, [{ type: 'expense', value: 250, created_at: '2026-10-23T12:00:00Z' }]).disponivel, -150);
});
