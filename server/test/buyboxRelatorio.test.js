// Relatório de Buy Box no Telegram (server/src/buyboxRelatorio.js) + regra
// compartilhada js/buyboxStatus.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { classificar } = require('../../js/buyboxStatus');
const { montarRelatorio, MAX_CHARS } = require('../src/buyboxRelatorio');

const AG = new Date('2026-10-27T08:30:00-03:00');
const R = (item_id, extra = {}) => ({ item_id, loja: 'UNIFULL', store_id: 1, title: 'Anúncio ' + item_id, permalink: `https://x/${item_id}`, calculated_at: '2026-10-27T05:00:00-03:00', status: 'competing', current_price: 100, winner_price: 90, winner_item_id: 'OUTRO', price_to_win: 89.99, boosts_missing: [], ...extra });

test('classificação: ganhando pelo winner = próprio item; compartilhando pela string oficial; aguardando sem sync', () => {
  assert.strictEqual(classificar({ calculado_em: 'x', winner_item_id: 'A', item_id: 'A', status: 'competing' }).chave, 'ganhando');
  assert.strictEqual(classificar({ calculado_em: 'x', winner_item_id: 'B', item_id: 'A', status: 'sharing_first_place' }).chave, 'compartilhando');
  assert.strictEqual(classificar({ calculado_em: 'x', winner_item_id: 'B', item_id: 'A', status: 'competing' }).chave, 'perdendo');
  assert.strictEqual(classificar({ calculado_em: null, winner_item_id: 'B', item_id: 'A' }).chave, 'aguardando');
  assert.strictEqual(classificar({ calculado_em: 'x', winner_item_id: null, item_id: 'A', status: 'listed' }).chave, 'sem_concorrencia');
});

test('por empresa, com contagem, preço do vencedor, diferença, preço pra ganhar e o que falta', () => {
  const r = montarRelatorio([
    R('MLB1', { title: 'Anti Mofo Secar 12un X 80g Natural - Desumidificador Armario', current_price: 75.04, winner_price: 74.08, price_to_win: 74.07, boosts_missing: ['fulfillment', 'free_shipping'] }),
    R('MLB2', { winner_item_id: 'MLB2', current_price: 50, winner_price: 50 }),
    R('MLB3', { status: 'sharing_first_place', current_price: 30, winner_price: 30 }),
    R('MLB4', { loja: 'TOP MIX', store_id: 2 }),
  ], {}, { agora: AG, dashUrl: 'https://painel' });
  assert.deepStrictEqual(r.lojas.map(l => [l.loja, l.contagem.perdendo, l.contagem.compartilhando, l.contagem.ganhando]), [['TOP MIX', 1, 0, 0], ['UNIFULL', 1, 1, 1]]);
  const t = r.lojas[1].mensagens.join('\n');
  assert.match(t, /BUY BOX — UNIFULL/);
  assert.match(t, /🔴 <b>PERDENDO \(1\)<\/b>/);
  assert.match(t, /Seu: <b>R\$\s75,04<\/b>  ·  🏆 Vencedor: <b>R\$\s74,08<\/b> \(\+R\$\s0,96\)/);
  assert.match(t, /🎯 Pra ganhar: <b>R\$\s74,07<\/b>  ·  falta: FULL, frete grátis/);
  assert.match(t, /🟡 <b>COMPARTILHANDO.*\(1\)/);
  assert.match(t, /🟢 <b>GANHANDO \(1\)<\/b>\n1\. <a href="https:\/\/x\/MLB2">Anúncio MLB2<\/a> — <b>R\$\s50,00<\/b>\n   🏪 <b>UNIFULL<\/b> · <code>MLB2<\/code>/);
  assert.match(t, /🏪 <b>UNIFULL<\/b> · <code>MLB1<\/code>\n   💰 Seu/);
  assert.match(t, /Abrir no painel/);
  assert.deepStrictEqual(r.novoEstado.map(e => e.chave).sort(), ['compartilhando', 'ganhando', 'perdendo', 'perdendo']);
});

test('mudanças desde o último relatório: perdeu / voltou a ganhar / empatou', () => {
  const r = montarRelatorio([R('A'), R('B', { winner_item_id: 'B' }), R('C', { status: 'sharing_first_place' }), R('D')],
    { A: 'ganhando', B: 'perdendo', C: 'ganhando', D: 'perdendo' }, { agora: AG });
  const t = r.lojas[0].mensagens[0];
  assert.match(t, /⚠️ Perdeu o Buy Box: Anúncio A/);
  assert.match(t, /🎉 Voltou a ganhar: Anúncio B/);
  assert.match(t, /🤝 Passou a empatar: Anúncio C/);
  assert.doesNotMatch(t, /Anúncio D<\/b>|: Anúncio D/);
  assert.strictEqual(r.lojas[0].mudou, 3);
});

test('perdendo: mais perto de ganhar primeiro; dado velho avisa; título com < escapado', () => {
  const r = montarRelatorio([R('LONGE', { current_price: 200, winner_price: 100 }), R('PERTO', { current_price: 101, winner_price: 100, title: 'A<b>', calculated_at: '2026-10-20T05:00:00-03:00' })], {}, { agora: AG });
  const t = r.lojas[0].mensagens[0];
  assert.ok(t.indexOf('A&lt;b&gt;') < t.indexOf('Anúncio LONGE'));
  assert.match(t, /⏳ dado de 20\/10/);
});

test('muitos anúncios: quebra em várias mensagens, todas abaixo do teto do Telegram', () => {
  const rows = Array.from({ length: 120 }, (_, k) => R('MLB' + k, { title: 'Produto com um título bem comprido número ' + k, boosts_missing: ['fulfillment'] }));
  const m = montarRelatorio(rows, {}, { agora: AG }).lojas[0].mensagens;
  assert.ok(m.length > 1);
  assert.ok(m.every(x => x.length <= 4096));
  assert.match(m[1], /continuação/);
  assert.strictEqual(m.join('\n').match(/^\d+\. /gm).length, 120);
});
