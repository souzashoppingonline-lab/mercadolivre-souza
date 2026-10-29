const test = require('node:test');
const assert = require('node:assert');
const av = require('../src/rankingAvisos');

const ad = { id: 1, ml_id: 'MLB123', title: 'Kit <Panelas>', fase: 'catalogo', sales_count: 21, milestone_every: 5, ciclo: 3 };

test('mudança de estágio mostra de → para e que o nº continua', () => {
  const m = av.fase(ad, 'rankeando', 'catalogo');
  assert.match(m, /🔀 <b>Mudou de estágio<\/b>/);
  assert.match(m, /🚀 Em rankeamento  ➜  <b>🏆 Catálogo \(Buy Box\)<\/b>/);
  assert.match(m, /21 venda\(s\) acumulada\(s\) — o nº continua/);
  assert.match(m, /Kit &lt;Panelas&gt;/);
  assert.match(m, /<code>MLB123<\/code>/);
});

test('ADS: só os campos que mudaram de verdade; nada mudou → null', () => {
  const antes = { ...ad, roas: '4.5', ads_investido: null, campanha_nome: 'Black' };
  const m = av.ads(ad, antes, { roas: '6', ads_investido: 120, campanha_nome: 'Black' });
  assert.match(m, /📈 ROAS: 4.5  ➜  <b>6<\/b>/);
  assert.match(m, /💸 Investido em ADS: —  ➜  <b>R\$\s120,00<\/b>/);
  assert.doesNotMatch(m, /Campanha:/);
  assert.equal(av.ads(ad, antes, { roas: 4.5 }), null);
  assert.equal(av.ads(ad, antes, { campanha_nome: 'Black' }), null);
});

test('entrou / reativado / pausa / saiu / nota / link', () => {
  assert.match(av.entrou({ ...ad, sales_count: 0 }), /➕ <b>Entrou no Rankeamento<\/b>[\s\S]*📍 Estágio: <b>🏆 Catálogo/);
  assert.doesNotMatch(av.entrou({ ...ad, sales_count: 0 }), /acumulada/);
  assert.match(av.entrou(ad, { reativado: true }), /Voltou pro Rankeamento[\s\S]*21 venda\(s\) acumulada/);
  assert.match(av.pausa(ad, false), /⏸️ <b>Acompanhamento pausado/);
  assert.match(av.saiu(ad), /Terminou com <b>21<\/b>/);
  assert.match(av.nota(ad, 'troquei <b>fotos</b>', 'fotos'), /Intervenção: 📸 Fotos[\s\S]*troquei &lt;b&gt;fotos/);
  assert.match(av.nota(ad, 'obs', null), /📝 <b>Anotação no card/);
  assert.match(av.link(ad, 'MLB999', 'catalogo', true), /➕ <code>MLB999<\/code> \(catalogo\)/);
});
