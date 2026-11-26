const test = require('node:test');
const assert = require('node:assert');
const { resumirRaioX, tendencia } = require('../src/raioX');

// 31 dias (30 fechados + hoje). `un(i)` = unidades do dia i (0 = mais antigo).
function serie(un, visitas = () => 100) {
  return Array.from({ length: 31 }, (_, i) => ({ data: `d${i}`, pedidos: un(i), unidades: un(i), visitas: i === 30 ? 0 : visitas(i) }));
}
const HOJE = new Date('2026-11-26T12:00:00Z');

test('janelas: vendas incluem hoje, conversão só dias fechados', () => {
  const r = resumirRaioX({ dias: serie(() => 2), estoque: 100, hoje: HOJE });
  const j3 = r.janelas.find((j) => j.dias === 3);
  assert.strictEqual(j3.unidades, 6);            // 2 dias fechados + hoje
  assert.strictEqual(j3.visitas, 200);           // hoje ainda sem visitas
  assert.strictEqual(j3.conversao, 2);           // 6 pedidos / 300 visitas (3 dias fechados) = 2%
  assert.deepStrictEqual(r.janelas.map((j) => j.dias), [3, 5, 7, 15, 21, 30]);
});

test('tendência e previsão com vendas subindo', () => {
  // 1/dia até 7 dias atrás, depois 3/dia na última semana fechada
  const r = resumirRaioX({ dias: serie((i) => (i >= 23 ? 3 : 1)), estoque: 30, hoje: HOJE });
  assert.strictEqual(r.tendencia.unidades_7.direcao, 'subindo');
  assert.strictEqual(r.tendencia.unidades_7.pct, 200);    // 21 vs 7
  // por dia = 0,6×3 + 0,4×(7×3+23×1)/30 = 1,8 + 0,587 = 2,39
  assert.strictEqual(r.previsao.por_dia, 2.4);
  assert.strictEqual(r.previsao.d7, 17);
  assert.strictEqual(r.cobertura.nivel, 'atencao');       // 30 / 2,39 ≈ 12,6 dias
  assert.match(r.frases.join(' '), /subindo 200%/);
});

test('queda com visitas caindo junto e estoque zerado', () => {
  const r = resumirRaioX({ dias: serie((i) => (i >= 23 ? 1 : 4), (i) => (i >= 23 ? 40 : 100)), estoque: 0, hoje: HOJE });
  assert.strictEqual(r.tendencia.unidades_7.direcao, 'caindo');
  assert.strictEqual(r.tendencia.visitas_7.direcao, 'caindo');
  assert.strictEqual(r.cobertura.nivel, 'sem_estoque');
  assert.match(r.frases.join(' '), /visitas também caíram/);
});

test('tendência: estável, sem dados e voltou a vender', () => {
  assert.strictEqual(tendencia(105, 100).direcao, 'estavel');
  assert.strictEqual(tendencia(0, 0).direcao, 'sem_dados');
  assert.strictEqual(tendencia(5, 0).direcao, 'subindo');
  assert.strictEqual(resumirRaioX({ dias: serie(() => 0), estoque: 10 }).cobertura.nivel, 'parado');
});
