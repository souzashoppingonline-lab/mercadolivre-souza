const test = require('node:test');
const assert = require('node:assert');
const { resumirRaioX, tendencia, pendenciasSeo, resumoBuybox, resumoDevolucoes, comparacaoMes, eventosPreco, quandoVende, alertaQueda } = require('../src/raioX');

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

test('qualidade: lista o que falta arrumar', () => {
  const q = pendenciasSeo({ score: 61.4, pictures_count: 3, has_video: false, description_word_count: 80, title_length: 58,
    has_gtin: false, has_brand: true, has_model: true, missing_required_attrs: ['COLOR', 'MATERIAL'] });
  assert.strictEqual(q.score, 61);
  assert.ok(q.pendencias.some((x) => /3 foto/.test(x)));
  assert.ok(q.pendencias.some((x) => /vídeo/.test(x)));
  assert.ok(q.pendencias.some((x) => /GTIN/.test(x)));
  assert.ok(q.pendencias.some((x) => /COLOR, MATERIAL/.test(x)));
  assert.ok(!q.pendencias.some((x) => /Título/.test(x)));
  assert.strictEqual(pendenciasSeo(null), null);
});

test('buy box e devoluções', () => {
  assert.strictEqual(resumoBuybox({ winner_item_id: 'MLB1', winner_price: 70 }, 'MLB1').ganhando, true);
  const b = resumoBuybox({ winner_item_id: 'MLB9', winner_price: 70, current_price: 79, price_to_win: 69.5, boosts_missing: ['free_shipping'] }, 'MLB1');
  assert.strictEqual(b.ganhando, false); assert.strictEqual(b.preco_para_ganhar, 69.5);
  const d = resumoDevolucoes({ devolucoes: [{ reason: 'Chegou quebrado' }, { reason: 'Chegou quebrado' }, { reason: 'Não gostei' }], pedidos: 60 });
  assert.strictEqual(d.total, 3); assert.strictEqual(d.taxa, 5);
  assert.deepStrictEqual(d.motivos[0], { motivo: 'Chegou quebrado', qtd: 2 });
});

test('mês passado: 30 dias fechados × 30 anteriores', () => {
  const dias = Array.from({ length: 61 }, (_, i) => ({ pedidos: i >= 30 ? 2 : 1, unidades: i >= 30 ? 2 : 1, visitas: i === 60 ? 0 : 100 }));
  const c = comparacaoMes(dias);
  assert.strictEqual(c.atual.unidades, 60); assert.strictEqual(c.anterior.unidades, 30);
  assert.strictEqual(c.var.unidades, 100); assert.strictEqual(c.var.conversao_pp, 1);
  assert.strictEqual(comparacaoMes(dias.slice(-31)), null);
});

test('marcadores de preço e promoção', () => {
  const ev = eventosPreco({
    precos: [{ old_price: 80, new_price: 75, changed_at: '2026-11-10T15:00:00Z' }, { old_price: 75, new_price: 75, changed_at: '2026-11-11T15:00:00Z' }],
    promocoes: [{ status: 'active', previous_status: null, promo_price: 69.9, discount_pct: 12.6, changed_at: '2026-11-12T15:00:00Z' },
      { status: 'finished', previous_status: 'active', changed_at: '2026-11-20T15:00:00Z' }, { status: 'pending', previous_status: 'candidate', changed_at: '2026-11-21T15:00:00Z' }] });
  assert.deepStrictEqual(ev.map((e) => e.tipo), ['preco_desce', 'promo_entra', 'promo_sai']);
  assert.match(ev[1].texto, /−13%/);
});

test('quando vende: melhor dia e faixa de 3 horas', () => {
  const q = quandoVende([{ dow: 1, hora: 20, unidades: 5 }, { dow: 1, hora: 21, unidades: 3 }, { dow: 5, hora: 9, unidades: 2 }]);
  assert.strictEqual(q.total, 10); assert.strictEqual(q.melhor_dia.nome, 'Segunda'); assert.strictEqual(q.melhor_dia.pct, 80);
  assert.strictEqual(q.melhor_faixa.de, 19); assert.strictEqual(q.melhor_faixa.pct, 80);
  assert.strictEqual(quandoVende([]).melhor_dia, null);
});

test('faixa de queda: só quem vendia bem e caiu 30%+, com motivo', () => {
  const t = (a, b, va, vb) => ({ unidades_7: tendencia(a, b), visitas_7: tendencia(va, vb) });
  assert.strictEqual(alertaQueda({ tendencia: t(4, 5, 100, 100) }), null);          // caiu 20%
  assert.strictEqual(alertaQueda({ tendencia: t(1, 4, 100, 100) }), null);          // vendia pouco
  const a = alertaQueda({ tendencia: t(6, 14, 500, 900), buybox: { ganhando: false, preco_vencedor: 70 }, cobertura: { nivel: 'ok' } });
  assert.strictEqual(a.pct, -57.1);
  assert.match(a.motivos[0], /Menos visitas/); assert.match(a.motivos[1], /buy box/);
  const b = alertaQueda({ tendencia: t(6, 14, 900, 900), cobertura: { nivel: 'ok' } });
  assert.match(b.motivos[0], /comprando menos/);
});
