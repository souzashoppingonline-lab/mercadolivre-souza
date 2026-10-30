const test = require('node:test');
const assert = require('node:assert');
const { analisarCarteira, addDias } = require('../src/iaEstrategista');

const FIM = '2026-10-29';
// série: n dias com {pedidos, unidades, fat, margem} por dia, terminando em FIM - offset
function serie(diasQtd, porDia, offset = 0) {
  const o = {};
  for (let i = 0; i < diasQtd; i++) o[addDias(FIM, -(i + offset))] = { ...porDia };
  return o;
}
const juntar = (...ss) => Object.assign({}, ...ss);
const base = (over) => ({ ranking_ad_id: 1, ml_id: 'MLB1', titulo: 'X', loja: 'L', fase: 'rankeando', estoque: 100, preco: 100, custo_ausente: false, ads: null, dias: {}, visitas: {}, ...over });

test('queda forte de pedidos → Recuperar vendas, comprovado, com números', () => {
  const a = base({ dias: juntar(serie(14, { pedidos: 1, unidades: 1, fat: 100, margem: 25, custo: 50 }, 0), serie(14, { pedidos: 3, unidades: 3, fat: 300, margem: 75, custo: 150 }, 14)) });
  // zera metade do período atual pra queda
  for (let i = 0; i < 14; i += 2) delete a.dias[addDias(FIM, -i)];
  const r = analisarCarteira([a], { periodo: 14, fim: FIM });
  const x = r.anuncios[0];
  assert.equal(x.analise.principal.codigo, 'B');
  assert.match(x.analise.problemas[0].texto, /Pedidos caíram de 42 para 7/);
  assert.equal(x.analise.problemas[0].tipo, 'comprovado');
  assert.ok(x.prioridade.nota > 0 && x.prioridade.fatores.length);
  assert.ok(x.analise.meta.includes('estimativa'));
});

test('sem estoque e vendendo → estoque crítico; nunca recomenda escalar', () => {
  const a = base({ estoque: 0, dias: serie(30, { pedidos: 2, unidades: 2, fat: 200, margem: 60, custo: 80 }) });
  const x = analisarCarteira([a], { periodo: 14, fim: FIM }).anuncios[0];
  assert.equal(x.analise.principal.codigo, 'F');
  assert.ok(!x.analise.categorias.some(c => c.codigo === 'E'));
  assert.match(x.analise.plano[0].acao, /Repor estoque/);
});

test('margem baixa com vendas → Rentabilidade com preço alvo calculado; custo ausente não inventa margem', () => {
  const a = base({ dias: serie(14, { pedidos: 1, unidades: 1, fat: 100, margem: 3, custo: 70, tarifa: 17, frete: 10 }) });
  const x = analisarCarteira([a], { periodo: 14, fim: FIM, cfg: { margem_minima_pct: 10, margem_alvo_pct: 20 } }).anuncios[0];
  assert.ok(x.analise.categorias.some(c => c.codigo === 'D'));
  assert.ok(x.analise.plano.some(p => /preço ficaria em ~R\$\s107,78/.test(p.acao)));
  const b = base({ custo_ausente: true, dias: serie(14, { pedidos: 1, unidades: 1, fat: 100, margem: 3 }) });
  const y = analisarCarteira([b], { periodo: 14, fim: FIM }).anuncios[0];
  assert.equal(y.metricas.mc_pct, null);
  assert.ok(y.analise.faltando.some(f => /Custo do produto não cadastrado/.test(f)));
  assert.ok(!y.analise.categorias.some(c => ['D', 'E', 'A', 'G'].includes(c.codigo)));
});

test('ROAS abaixo do equilíbrio → Reduzir investimento', () => {
  const a = base({ ads: { roas: 3, orcamento_diario: 50 }, dias: serie(28, { pedidos: 1, unidades: 1, fat: 100, margem: 20, custo: 60 }) });
  const x = analisarCarteira([a], { periodo: 14, fim: FIM }).anuncios[0];
  assert.ok(x.analise.categorias.some(c => c.codigo === 'G'));
  assert.equal(x.analise.roas_minimo, 5);
  assert.ok(!x.analise.categorias.some(c => c.codigo === 'E' || c.codigo === 'A')); // não manda investir mais
});

test('conversão: compara com grupo de ≥5 do mesmo estágio; grupo pequeno não vira referência', () => {
  const vis = n => Object.fromEntries(Object.keys(serie(28, {})).map(d => [d, n]));
  const bons = [2, 3, 4, 5, 6].map(i => base({ ranking_ad_id: i, ml_id: 'MLB' + i, visitas: vis(20), dias: serie(28, { pedidos: 1, unidades: 1, fat: 100, margem: 30, custo: 50 }) }));
  const ruim = base({ ranking_ad_id: 1, visitas: vis(100), dias: serie(28, { pedidos: 1, unidades: 1, fat: 100, margem: 30, custo: 50 }) });
  const r = analisarCarteira([ruim, ...bons], { periodo: 14, fim: FIM });
  const x = r.anuncios.find(a => a.ranking_ad_id === 1);
  assert.ok(x.analise.categorias.some(c => c.codigo === 'C'));
  assert.equal(x.analise.problemas.find(p => /Conversão/.test(p.texto)).tipo, 'comprovado');
  // só 2 anúncios: sem referência confiável → limiar absoluto, marcado como hipótese
  const r2 = analisarCarteira([ruim, bons[0]], { periodo: 14, fim: FIM });
  const y = r2.anuncios.find(a => a.ranking_ad_id === 1);
  assert.equal(y.analise.referencia.conversao, null);
});

test('crescendo com margem boa e estoque → Escalar; painel e respostas preenchidos', () => {
  const a = base({ estoque: 500, dias: juntar(serie(14, { pedidos: 3, unidades: 3, fat: 300, margem: 60, custo: 150 }, 0), serie(14, { pedidos: 2, unidades: 2, fat: 200, margem: 40, custo: 100 }, 14)) });
  const r = analisarCarteira([a], { periodo: 14, fim: FIM, cfg: { margem_minima_pct: 10, margem_alvo_pct: 20 } });
  const x = r.anuncios[0];
  assert.equal(x.analise.principal.codigo, 'E');
  assert.equal(r.painel.potencial_crescimento, 1);
  assert.ok(r.respostas.merecem_investimento.length === 1);
  assert.ok(x.qualidade >= 50);
});
