const test = require('node:test');
const assert = require('node:assert');
const { montarResumo } = require('../src/rankingVendasResumo');

test('agrupa por estágio, soma vendas/valor e mostra o nº acumulado', () => {
  const r = montarResumo([
    { fase: 'rankeando', ml_id: 'MLB1', title: 'Kit Panelas', vendas: 3, valor: '150.00', nro: 23 },
    { fase: 'rankeando', ml_id: 'MLB2', title: 'Anti Mofo', vendas: 1, valor: '20', nro: 5 },
    { fase: 'catalogo', ml_id: 'MLB3', title: 'Garrafa <térmica>', vendas: 2, valor: '80', nro: 41 },
  ], { titulo: 'X', periodo: '12:00 → 16:00', hoje: [{ fase: 'rankeando', vendas: 9 }, { fase: 'catalogo', vendas: 2 }] });
  assert.equal(r.total, 6);
  assert.match(r.texto, /🚀 <b>EM RANKEAMENTO<\/b>\n🛒 <b>4<\/b> venda\(s\)   💰 <b>R\$\s170,00<\/b>/);
  assert.match(r.texto, /🥇 Kit Panelas\n      ➜ <b>3<\/b> venda\(s\)   🔢 venda nº <b>23<\/b>/);
  assert.match(r.texto, /Garrafa &lt;térmica&gt;/);
  assert.match(r.texto, /🛡️ <b>RANQUEADO<\/b>\n😴 Nenhuma venda/);
  assert.match(r.texto, /TOTAL: 6 venda\(s\)/);
  assert.match(r.texto, /Hoje até agora: 11 venda\(s\)<\/b>\n🚀 9   🏆 2   🛡️ 0/);
  // Kit Panelas (3) antes de Anti Mofo (1)
  assert.ok(r.texto.indexOf('Kit Panelas') < r.texto.indexOf('Anti Mofo'));
});

test('sem vendas: todos os estágios com 0 e sem linha "hoje" no fechamento', () => {
  const r = montarResumo([], { titulo: 'FECHAMENTO', periodo: 'ontem' });
  assert.equal(r.total, 0);
  assert.equal((r.texto.match(/😴 Nenhuma venda/g) || []).length, 5);
  assert.doesNotMatch(r.texto, /Hoje até agora/);
});

test('mais de 8 anúncios no estágio: corta e avisa', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ fase: 'ranqueado', ml_id: 'M' + i, title: 'Item ' + i, vendas: 1, valor: 10 }));
  const r = montarResumo(rows, { titulo: 'X', periodo: 'p' });
  assert.match(r.texto, /\+3 anúncio\(s\)/);
});
