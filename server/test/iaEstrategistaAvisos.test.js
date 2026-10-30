const test = require('node:test');
const assert = require('node:assert');
const av = require('../src/iaEstrategistaAvisos');

const anuncio = (id, nota, extra = {}) => ({
  ranking_ad_id: id, ml_id: 'MLB' + id, titulo: 'Kit <Panelas> ' + id, loja: 'UNIFULL', fase: 'catalogo',
  prioridade: { nota }, analise: { principal: { ico: '📉', nome: 'Recuperar vendas' }, problemas: [{ texto: 'Pedidos caíram de 42 para 5' }], oportunidades: [], faltando: [], plano: [{ acao: 'Comparar preço' }], impacto_mensal: 1234 }, ...extra,
});
const carteira = (ads) => ({ periodo: { dias: 14 }, painel: { analisados: ads.length, precisam_intervencao: ads.filter(a => a.prioridade.nota >= 60).length, potencial_faturamento_mensal: 5000 }, anuncios: ads });

test('prioridades do dia: top 5 (≥20), medalhas, 1ª ação, críticos novos e link', () => {
  const ads = [90, 85, 70, 50, 40, 30, 10].map((n, i) => anuncio(i + 1, n));
  const t = av.textoPrioridades(carteira(ads), { novosCriticos: [{ x: ads[0], antes: 65 }], dashUrl: 'https://x' });
  assert.match(t, /PRIORIDADES DO DIA/);
  assert.equal((t.match(/👉 <b>1ª ação:<\/b>/g) || []).length, 5);
  assert.match(t, /🥇 <b>\[90\] Kit &lt;Panelas&gt; 1<\/b>/);
  assert.match(t, /🏆 Catálogo \(Buy Box\)/);
  assert.match(t, /ENTRARAM EM CRÍTICO[\s\S]*65 ➜ <b>90<\/b>/);
  assert.match(t, /href="https:\/\/x\/pages\/bi-ia-estrategista.html"/);
  assert.match(av.textoPrioridades(carteira([anuncio(1, 5)]), {}), /Nenhum anúncio com prioridade relevante/);
});

test('crítico, paradas e resultado', () => {
  assert.match(av.textoCriticos([{ x: anuncio(3, 82), antes: null }], { dashUrl: 'https://x' }), /— ➜ <b>82<\/b>[\s\S]*\?anuncio=3/);
  const parada = av.textoParadas([{ produto: 'Kit', acao: 'Repor', status: 'pendente', status_desde: '2026-10-01T12:00:00Z', responsavel: null }], { agora: '2026-10-11T12:00:00Z' });
  assert.match(parada, /⏳ Pendente há <b>10 dia\(s\)<\/b> · 👤 sem responsável/);
  const a = { ranking_ad_id: 1, produto: 'Kit Panelas', acao: 'Trocar foto', antes_depois: { dias_depois: 14,
    antes: { pedidos_dia: 0.8, fat_dia: 80, margem_dia: 16, mc_pct: 20, conversao: 1 }, depois: { pedidos_dia: 1.4, fat_dia: 140, margem_dia: 35, mc_pct: 25, conversao: 1.6 } } };
  assert.match(av.textoResultado(a), /Pedidos\/dia: 0,8 ➜ <b>1,4<\/b> ⬆️ <i>\(\+75%\)<\/i>[\s\S]*MC: 20% ➜ <b>25%<\/b> \(\+5 p\.p\.\)[\s\S]*não prova/);
  assert.match(av.resumoResultado(a), /^\[automático\] Kit Panelas: pedidos\/dia 0,8 → 1,4 \(\+75%\)/);
  assert.equal(av.resumoResultado({ produto: 'x' }), null);
});
