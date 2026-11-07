const test = require('node:test');
const assert = require('node:assert');
const { linhaRitmo, textoCobertura, linhaConversao, linhaPromocao, linhaBuybox, simularPreco, linhaSugestaoPreco, diasCobertura } = require('../src/vendaInfo');

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

test('buy box', () => {
  const agora = Date.parse('2026-11-07T15:00:00Z');
  const base = { item_id: 'MLB1', calculated_at: '2026-11-07T14:50:00Z' };
  assert.match(linhaBuybox({ ...base, winner_item_id: 'MLB1' }, agora), /ganhando/);
  assert.match(linhaBuybox({ ...base, winner_item_id: 'MLB9', status: 'sharing_first_place' }, agora), /dividindo o 1º lugar/);
  const p = linhaBuybox({ ...base, winner_item_id: 'MLB9', winner_price: 74.9, current_price: 78.99, price_to_win: 74.8 }, agora);
  assert.match(p, /PERDENDO<\/b> para concorrente a <b>R\$\s74,90/);
  assert.match(p, /seu preço R\$\s78,99 · para ganhar: <b>R\$\s74,80/);
  assert.doesNotMatch(p, /conferido/);
  assert.match(linhaBuybox({ ...base, calculated_at: '2026-11-07T10:00:00Z', winner_item_id: 'MLB1' }, agora), /conferido há 5h/);
  assert.match(linhaBuybox({ ...base, calculated_at: '2026-11-04T10:00:00Z', winner_item_id: 'MLB1' }, agora), /conferido há 3 dias/);
  assert.strictEqual(linhaBuybox(null), '');
  assert.strictEqual(linhaBuybox({ item_id: 'MLB1', calculated_at: null }), '');
  assert.strictEqual(linhaBuybox({ ...base, winner_item_id: null }, agora), '');
});

// Linha de margem como sai de calcularMargemLinha: venda de R$ 100 (1 un),
// custo 50, imposto 10 (10%), tarifa 14 (14%), frete vendedor 10 → margem 16 (16%).
const LINHA = { quantity: 1, faturamento: 100, custo: 50, imposto: 10, tarifa: 14, frete_comprador: 0, freteVend: 10, margem: 16, mc_pct: 16, custo_ausente: false };

test('simular preço: custo/frete fixos, tarifa e imposto proporcionais', () => {
  const s = simularPreco(LINHA, 95);   // 95 - 50 - 9,5 - 13,3 - 10 = 12,2
  assert.ok(Math.abs(s.margem - 12.2) < 1e-9);
  assert.ok(Math.abs(s.pct - 12.842) < 0.01);
  assert.ok(Math.abs(simularPreco(LINHA, 100).margem - 16) < 1e-9);   // mesmo preço = mesma margem
});

test('sugestão: perdendo o Buy Box mostra a margem no preço pra ganhar', () => {
  const t = linhaSugestaoPreco({ linha: LINHA, buybox: { chave: 'perdendo', price_to_win: 95 } });
  assert.match(t, /Baixar para <b>R\$\s95,00<\/b> \(−5%\)/);
  assert.match(t, /margem ~R\$\s16,00 \(16%\) → <b>~R\$\s12,20 \(13%\)/);
  assert.doesNotMatch(t, /prejuízo/);
  const p = linhaSugestaoPreco({ linha: LINHA, buybox: { chave: 'perdendo', price_to_win: 70 } });   // 70-50-7-9,8-10 = −6,8
  assert.match(p, /~−R\$\s6,80/);
  assert.match(p, /daria prejuízo/);
  assert.match(linhaSugestaoPreco({ linha: { ...LINHA, custo_ausente: true }, buybox: { chave: 'perdendo', price_to_win: 95 } }), /cadastre o custo/);
  // preço pra ganhar acima do atual → nada a sugerir
  assert.strictEqual(linhaSugestaoPreco({ linha: LINHA, buybox: { chave: 'perdendo', price_to_win: 101 } }), '');
});

test('sugestão: vende rápido com estoque acabando → subir o preço', () => {
  const t = linhaSugestaoPreco({ linha: LINHA, buybox: null, cobertura: 4.6, unidadesDia: 3 });
  assert.match(t, /estoque acaba em ~5 dias: dá para subir o preço — ex\.: \+5% → <b>R\$\s105,00<\/b>/);
  assert.match(t, /→ <b>~R\$\s19,80 \(19%\)/);   // 105-50-10,5-14,7-10 = 19,8
  assert.match(linhaSugestaoPreco({ linha: LINHA, cobertura: 3, unidadesDia: 2, promo: true }), /encerrar a promoção/);
  assert.match(linhaSugestaoPreco({ linha: LINHA, cobertura: 0.5, unidadesDia: 2 }), /estoque acaba hoje/);
  // cobertura folgada, venda lenta ou perdendo o Buy Box → não sugere subir
  assert.strictEqual(linhaSugestaoPreco({ linha: LINHA, cobertura: 20, unidadesDia: 3 }), '');
  assert.strictEqual(linhaSugestaoPreco({ linha: LINHA, cobertura: 4, unidadesDia: 0.5 }), '');
  assert.strictEqual(linhaSugestaoPreco({ linha: LINHA, buybox: { chave: 'perdendo', price_to_win: 0 }, cobertura: 4, unidadesDia: 3 }), '');
  assert.strictEqual(diasCobertura({ estoque: 14, unidades: 84, diasJanela: 30 }), 5);
});
