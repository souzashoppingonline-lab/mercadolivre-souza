// Detecção e texto das mudanças de catálogo (server/src/buyboxMudancas.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { detectarMudancas, textoMudancas } = require('../src/buyboxMudancas');

const L = (extra = {}) => ({ item_id: 'MLB1', status: 'competing', winner_item_id: 'MLB9', winner_price: 74.08, current_price: 75.04, calculated_at: '2026-10-27T05:00:00Z', ...extra });

test('1º sync não avisa; nada mudou não avisa', () => {
  assert.deepStrictEqual(detectarMudancas(null, L()), []);
  assert.deepStrictEqual(detectarMudancas({ ...L(), calculated_at: null }, L()), []);
  assert.deepStrictEqual(detectarMudancas(L(), L({ calculated_at: '2026-10-27T09:00:00Z' })), []);
});

test('perdeu, voltou a ganhar, passou a empatar, ficou sem concorrente', () => {
  assert.deepStrictEqual(detectarMudancas(L({ winner_item_id: 'MLB1' }), L()), [{ tipo: 'status', de: 'ganhando', para: 'perdendo' }]);
  assert.deepStrictEqual(detectarMudancas(L(), L({ winner_item_id: 'MLB1' })), [{ tipo: 'status', de: 'perdendo', para: 'ganhando' }]);
  assert.deepStrictEqual(detectarMudancas(L(), L({ status: 'sharing_first_place' })), [{ tipo: 'status', de: 'perdendo', para: 'compartilhando' }]);
  assert.deepStrictEqual(detectarMudancas(L(), L({ winner_item_id: null, status: 'listed' })), [{ tipo: 'status', de: 'perdendo', para: 'sem_concorrencia' }]);
});

test('perdendo: vencedor mudou o preço / outro vendedor assumiu; seu preço mudou (qualquer status)', () => {
  assert.deepStrictEqual(detectarMudancas(L(), L({ winner_price: 72.9 })), [{ tipo: 'preco_vencedor', de: 74.08, para: 72.9 }]);
  assert.deepStrictEqual(detectarMudancas(L(), L({ winner_item_id: 'MLB8' })), [{ tipo: 'novo_vencedor', de: 'MLB9', para: 'MLB8' }]);
  assert.deepStrictEqual(detectarMudancas(L({ winner_item_id: 'MLB1' }), L({ winner_item_id: 'MLB1', current_price: 73.99 })), [{ tipo: 'seu_preco', de: 75.04, para: 73.99 }]);
  assert.deepStrictEqual(detectarMudancas(L(), L({ winner_price: '74.081' })), []); // menos de 1 centavo
});

test('texto: por empresa, por anúncio, perdeu primeiro, com preço do vencedor e o que falta', () => {
  const base = { loja: 'UNIFULL', store_id: 1, permalink: 'https://x/MLB1', title: 'Anti Mofo Secar 12un', current_price: 75.04, winner_price: 72.9, price_to_win: 72.89, winner_item_id: 'MLB9', boosts_missing: ['fulfillment'] };
  const r = textoMudancas([
    { ...base, item_id: 'MLB1', tipo: 'preco_vencedor', de: 74.08, para: 72.9 },
    { ...base, item_id: 'MLB2', title: 'Garrafa', tipo: 'status', de: 'ganhando', para: 'perdendo', current_price: 60, winner_price: 58 },
    { ...base, item_id: 'MLB3', title: 'Panela', tipo: 'status', de: 'perdendo', para: 'ganhando', winner_item_id: 'MLB3', current_price: 99 },
    { ...base, item_id: 'MLB1', tipo: 'seu_preco', de: 76, para: 75.04 },
    { ...base, loja: 'TOP MIX', store_id: 2, item_id: 'MLB7', tipo: 'novo_vencedor', de: 'A', para: 'B' },
  ], { agora: new Date('2026-10-27T17:10:00Z') });
  assert.deepStrictEqual(r.map(x => [x.loja, x.itens]), [['TOP MIX', 1], ['UNIFULL', 3]]);
  const t = r[1].mensagens[0];
  assert.match(t, /^🔔 <b>CATÁLOGO — UNIFULL<\/b> · 14:10/);
  assert.ok(t.indexOf('PERDEU') < t.indexOf('VOLTOU A GANHAR') && t.indexOf('VOLTOU A GANHAR') < t.indexOf('BAIXOU')); // status antes de preço
  assert.match(t, /💸 <b>Vencedor BAIXOU o preço<\/b>: R\$\s74,08 → <b>R\$\s72,90<\/b> ⬇️\n✏️ <b>Seu preço mudou<\/b>/);
  assert.match(t, /Vencedor: <b>R\$\s72,90<\/b> \(você está R\$\s2,14 acima\)\n🎯 Pra ganhar: <b>R\$\s72,89<\/b> · falta: FULL/);
  assert.match(t, /🎉 <b>VOLTOU A GANHAR o Buy Box<\/b>\n📦 <a href="https:\/\/x\/MLB1">Panela<\/a>\n🏪 <b>UNIFULL<\/b> · <code>MLB3<\/code>\n💰 Seu: <b>R\$\s99,00<\/b> · 🏆 você é o vencedor/);
});
