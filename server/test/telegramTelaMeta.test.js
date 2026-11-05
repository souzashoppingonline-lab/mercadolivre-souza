// calcularMeta (slide 🎯 Meta do mês da Tela Telegram, v164) — dados inventados.
const test = require('node:test');
const assert = require('node:assert');
const { calcularMeta } = require('../src/metaMes');

const dia = (y, m, d) => new Date(y, m - 1, d, 12);

test('meta geral (store_id vazio) tem prioridade sobre as por loja', () => {
  const goals = [{ month: 11, year: 2026, store_id: null, goal_value: 300000 }, { month: 11, year: 2026, store_id: 'a', goal_value: 999 }];
  const r = calcularMeta(goals, 100000, dia(2026, 11, 11));
  assert.strictEqual(r.meta, 300000);
  assert.strictEqual(r.falta, 200000);
  assert.strictEqual(r.dias_restantes, 20);          // 11 a 30/11, contando hoje
  assert.strictEqual(r.por_dia, 10000);
  assert.strictEqual(r.pct, 33.3);
});

test('sem linha geral soma as metas por loja; outro mês não entra', () => {
  const goals = [{ month: 11, year: 2026, store_id: 'a', goal_value: 100 }, { month: 11, year: 2026, store_id: 'b', goal_value: 50 }, { month: 10, year: 2026, store_id: null, goal_value: 1e9 }];
  assert.strictEqual(calcularMeta(goals, 0, dia(2026, 11, 1)).meta, 150);
});

test('sem meta → null; meta batida → falta 0', () => {
  assert.strictEqual(calcularMeta([], 10, dia(2026, 11, 5)), null);
  const r = calcularMeta([{ month: 11, year: 2026, goal_value: 100 }], 130, dia(2026, 11, 30));
  assert.strictEqual(r.falta, 0); assert.strictEqual(r.por_dia, 0); assert.strictEqual(r.dias_restantes, 1);
});
