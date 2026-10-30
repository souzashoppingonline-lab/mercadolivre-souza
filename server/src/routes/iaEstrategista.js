// IA Estrategista de Performance por Anúncio — /api/bi/ia-estrategista
// (módulo Inteligência de Negócio, aba ao lado de "Vendas por Estágio").
//
// Separação de camadas (pedido do usuário, §12):
//  1. coletar()  — consolida no backend, numa ÚNICA leitura por fonte, as
//     séries diárias dos anúncios do Rankeamento: pedidos/margem (mesma
//     fórmula de sempre: VENDA_DETALHE_SELECT + calcularMargemLinha),
//     visitas (item_visits), estoque/custo (items), ADS (card do Rankeamento),
//     Buy Box (catalog_competition) e margens mínima/alvo (Analista Ecom).
//  2. iaEstrategista.analisarCarteira() — motor determinístico (puro).
//  3. LLM sob demanda, 1 anúncio por vez, só com os números daquele anúncio
//     (ai/iaEstrategistaNarrativa.js), com cache por hash de entrada (24h) e
//     limite no lote.
// Nada aqui altera anúncio/campanha — só recomenda (regra 12).
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { cached } = require('../db/cached');
const llm = require('../ai/llm');
const narrativa = require('../ai/iaEstrategistaNarrativa');
const { VENDA_DETALHE_SELECT, calcularMargemLinha, buscarImpostoFlexAtivo, buscarFreteMotoboy } = require('../vendaMargem');
const { getConfigGlobal } = require('../analistaEcom');
const { classificar: classificarBuybox } = require('../../../js/buyboxStatus');
const motor = require('../iaEstrategista');

const router = express.Router();
const PERIODOS = [7, 14, 30];
const HISTORICO_DIAS = 60;          // 2 × maior período
const CACHE_TTL = 600;              // 10 min — carteira inteira
const ANALISE_IA_VALIDADE_H = 24;   // mesma entrada dentro disso → devolve a salva
const LOTE_MAX = 20;                // teto de anúncios por "analisar prioritários"
const STATUS = ['pendente', 'em_execucao', 'concluida', 'descartada'];

const diaSP = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const ontemSP = () => motor.addDias(diaSP(new Date()), -1);
const usuario = req => req.staffUser?.username || null;

async function coletar({ storeId }) {
  const p = []; let filtro = '';
  if (storeId) { p.push(storeId); filtro = `AND ra.store_id = $${p.length}::bigint`; }
  const { rows: ads } = await pool.query(
    `SELECT ra.id, ra.ml_id, ra.fase, ra.store_id, ra.ads_investido, ra.roas, ra.orcamento_diario, ra.campanha_nome,
            COALESCE(i.title, ra.title) AS titulo, i.available_quantity, i.status, i.price, i.permalink, i.thumbnail,
            (i.cost_updated_at IS NULL) AS custo_ausente, i.margem_alvo_pct, s.nickname AS loja
       FROM ranking_ads ra
       LEFT JOIN items i ON i.ml_id = ra.ml_id
       LEFT JOIN stores s ON s.id = ra.store_id
      WHERE ra.active = true ${filtro}`, p);
  if (!ads.length) return { cfg: null, anuncios: [] };
  const adIds = ads.map(a => a.id);
  const { rows: links } = await pool.query(`SELECT ranking_ad_id, ml_id FROM ranking_ad_links WHERE ranking_ad_id = ANY($1::int[])`, [adIds]);
  const itemParaAd = new Map(ads.map(a => [a.ml_id, a.id]));
  links.forEach(l => { if (!itemParaAd.has(l.ml_id)) itemParaAd.set(l.ml_id, l.ranking_ad_id); });
  const itemIds = [...itemParaAd.keys()];
  const desde = motor.addDias(diaSP(new Date()), -HISTORICO_DIAS);

  const [impostoFlexAtivo, freteMotoboy, cfg] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy(), getConfigGlobal()]);
  const [{ rows: pedidos }, { rows: visitas }, { rows: catalogo }] = await Promise.all([
    pool.query(
      `-- ia-estrategista
       ${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled' AND o.date_created >= $1::date AND o.item_id = ANY($2::text[])
       ORDER BY o.date_created DESC LIMIT 50000`, [desde, itemIds]),
    pool.query(`SELECT item_id, date::text AS dia, visits FROM item_visits WHERE item_id = ANY($1::text[]) AND date >= $2::date`, [itemIds, desde]),
    pool.query(`SELECT item_id, status, winner_item_id, winner_price, price_to_win, calculated_at FROM catalog_competition WHERE item_id = ANY($1::text[])`, [ads.map(a => a.ml_id)]),
  ]);

  const porAd = new Map(ads.map(a => [a.id, { dias: {}, visitas: {}, sku: null }]));
  for (const raw of pedidos) {
    const adId = itemParaAd.get(raw.item_id); if (!adId) continue;
    const r = calcularMargemLinha(raw, impostoFlexAtivo, freteMotoboy);
    const acc = porAd.get(adId);
    const d = diaSP(r.date_created);
    const x = acc.dias[d] || (acc.dias[d] = { pedidos: 0, unidades: 0, fat: 0, margem: 0, custo: 0, tarifa: 0, frete: 0 });
    x.pedidos += 1; x.unidades += Number(r.quantity) || 0; x.fat += Number(r.faturamento) || 0; x.margem += r.margem;
    x.custo += r.custo; x.tarifa += r.tarifa; x.frete += r.freteVend + (Number(r.frete_comprador) || 0);
    if (!acc.sku && r.sku) acc.sku = r.sku; // pedidos vêm do mais novo pro mais velho
  }
  for (const v of visitas) {
    const adId = itemParaAd.get(v.item_id); if (!adId) continue;
    const acc = porAd.get(adId);
    acc.visitas[v.dia] = (acc.visitas[v.dia] || 0) + (Number(v.visits) || 0);
  }
  const bb = new Map(catalogo.map(c => [c.item_id, c]));
  return {
    cfg,
    anuncios: ads.map(a => {
      const acc = porAd.get(a.id);
      const c = bb.get(a.ml_id);
      const st = c ? classificarBuybox({ calculado_em: c.calculated_at, winner_item_id: c.winner_item_id, item_id: c.item_id, status: c.status }) : null;
      return {
        ranking_ad_id: a.id, ml_id: a.ml_id, titulo: a.titulo, sku: acc.sku, loja: a.loja, store_id: a.store_id, fase: a.fase || 'rankeando',
        estoque: a.available_quantity, preco: a.price != null ? Number(a.price) : null, status_anuncio: a.status,
        permalink: a.permalink, thumbnail: a.thumbnail, custo_ausente: !!a.custo_ausente,
        margem_alvo_pct: a.margem_alvo_pct != null ? Number(a.margem_alvo_pct) : null,
        ads: { investido: a.ads_investido != null ? Number(a.ads_investido) : null, roas: a.roas != null ? Number(a.roas) : null, orcamento_diario: a.orcamento_diario != null ? Number(a.orcamento_diario) : null, campanha: a.campanha_nome },
        buybox: st && c ? { chave: st.chave, label: st.label, winner_price: c.winner_price, price_to_win: c.price_to_win } : null,
        dias: acc.dias, visitas: acc.visitas,
      };
    }),
  };
}

function parse(q) {
  const periodo = PERIODOS.includes(Number(q.days)) ? Number(q.days) : 14;
  const storeId = q.store_id && /^\d+$/.test(String(q.store_id)) ? String(q.store_id) : '';
  return { periodo, storeId };
}
async function carteira({ periodo, storeId, semCache = false }) {
  const fim = ontemSP();
  const calc = async () => {
    const dados = await coletar({ storeId });
    if (!dados.anuncios.length) return { periodo: { dias: periodo, de: motor.addDias(fim, -(periodo - 1)), ate: fim }, painel: { analisados: 0 }, respostas: {}, anuncios: [] };
    return motor.analisarCarteira(dados.anuncios, { periodo, fim, cfg: dados.cfg });
  };
  if (semCache) return calc();
  return cached(`ia-estrategista:${periodo}:${storeId || 'all'}:${fim}`, CACHE_TTL, calc);
}

// Lista (painel + ranking de prioridade). Filtros de estágio/prioridade/
// problema são da tela (a referência comparável precisa da carteira inteira).
router.get('/', async (req, res) => {
  try {
    const { periodo, storeId } = parse(req.query);
    const r = await carteira({ periodo, storeId, semCache: req.query.refresh === '1' });
    // Lista enxuta: o detalhe completo vem em /anuncio/:id.
    const lista = r.anuncios.map(x => ({
      ranking_ad_id: x.ranking_ad_id, ml_id: x.ml_id, titulo: x.titulo, sku: x.sku, loja: x.loja, store_id: x.store_id,
      fase: x.fase, fase_nome: x.fase_nome, thumbnail: x.thumbnail,
      prioridade: x.prioridade.nota, faixa: x.prioridade.faixa, qualidade: x.qualidade,
      fat: x.metricas.fat, pedidos: x.metricas.pedidos, margem: x.metricas.margem, mc_pct: x.metricas.mc_pct,
      conversao: x.metricas.conversao, var_pedidos: x.metricas.var_pedidos, cobertura_dias: x.metricas.cobertura_dias,
      principal: x.analise.principal, categorias: x.analise.categorias.map(c => c.codigo),
      problema: x.analise.problemas[0]?.texto || x.analise.oportunidades[0]?.texto || (x.analise.principal.chave === 'dados_insuficientes' ? x.analise.faltando[0] : null),
      acao: x.analise.plano[0]?.acao || (x.analise.faltando.length ? `Completar dados: ${x.analise.faltando[0].split(' — ')[0]}` : null), impacto_mensal: x.analise.impacto_mensal, faltando: x.analise.faltando.length,
    }));
    res.json({ periodo: r.periodo, painel: r.painel, respostas: r.respostas, anuncios: lista, ia_configurada: llm.isConfigured(),
      aviso_estagio: 'Estágio = estágio ATUAL do anúncio. Não existe histórico confiável de estágio: as vendas do período não significam que o anúncio estava nesse estágio quando vendeu.' });
  } catch (e) {
    console.error('[api/ia-estrategista]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Contexto mínimo que vai pra IA (só este anúncio) — e o hash dele.
function contextoIa(x, periodo) {
  return {
    anuncio: { titulo: x.titulo, ml_id: x.ml_id, sku: x.sku, loja: x.loja, estagio_atual: x.fase_nome, aviso_estagio: 'estágio atual; não é o estágio de quando as vendas ocorreram' },
    periodo_dias: periodo, metricas: x.metricas,
    diagnostico_motor: { principal: x.analise.principal, categorias: x.analise.categorias, problemas: x.analise.problemas, oportunidades: x.analise.oportunidades, plano: x.analise.plano, meta: x.analise.meta, faltando: x.analise.faltando, referencia: x.analise.referencia, margem_minima_pct: x.analise.margem_minima_pct, roas_minimo: x.analise.roas_minimo },
    prioridade: x.prioridade, qualidade: x.qualidade,
  };
}
const hashDe = obj => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');

async function acharAnuncio(req) {
  const { periodo, storeId } = parse(req.query.days ? req.query : (req.body || {}));
  const r = await carteira({ periodo, storeId });
  const x = r.anuncios.find(a => String(a.ranking_ad_id) === String(req.params.id));
  return { r, x, periodo };
}

// Detalhe de 1 anúncio: tudo do motor + série diária + análises salvas + ações.
router.get('/anuncio/:id', async (req, res) => {
  try {
    const { r, x, periodo } = await acharAnuncio(req);
    if (!x) return res.status(404).json({ error: 'anúncio não está ativo no Rankeamento (ou fora do filtro de empresa)' });
    const [{ rows: analises }, { rows: acoes }] = await Promise.all([
      pool.query(`SELECT id, periodo_dias, prioridade, categoria, ia, modelo, criado_por, created_at FROM ia_estrategista_analises WHERE ranking_ad_id = $1 ORDER BY created_at DESC LIMIT 5`, [x.ranking_ad_id]),
      pool.query(`SELECT * FROM ia_estrategista_acoes WHERE ranking_ad_id = $1 ORDER BY created_at DESC LIMIT 50`, [x.ranking_ad_id]),
    ]);
    res.json({ periodo: r.periodo, anuncio: x, analises, acoes: await comAntesDepois(acoes), ia_configurada: llm.isConfigured(), hash: hashDe(contextoIa(x, periodo)) });
  } catch (e) {
    console.error('[api/ia-estrategista/anuncio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function gerarIa(x, periodo, { force = false, por = null } = {}) {
  const ctx = contextoIa(x, periodo);
  const hash = hashDe(ctx);
  if (!force) {
    const { rows } = await pool.query(
      `SELECT * FROM ia_estrategista_analises WHERE ranking_ad_id = $1 AND input_hash = $2 AND ia IS NOT NULL
         AND created_at > now() - ($3 || ' hours')::interval ORDER BY created_at DESC LIMIT 1`,
      [x.ranking_ad_id, hash, String(ANALISE_IA_VALIDADE_H)]);
    if (rows[0]) return { analise: rows[0], cache: 'hit' };
  }
  const ia = await narrativa.gerarAnalise(ctx, { productId: x.ml_id });
  const { rows } = await pool.query(
    `INSERT INTO ia_estrategista_analises (ranking_ad_id, ml_id, periodo_dias, input_hash, prioridade, categoria, diagnostico, ia, modelo, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [x.ranking_ad_id, x.ml_id, periodo, hash, x.prioridade.nota, x.analise.principal.codigo, JSON.stringify(ctx), JSON.stringify(ia), llm.DEFAULT_MODEL, por]);
  return { analise: rows[0], cache: 'miss' };
}

// GERAR NOVA ANÁLISE (IA) de 1 anúncio. Mesma entrada em 24h → devolve a
// salva (cache: 'hit'); { force: true } gera de novo mesmo assim.
router.post('/anuncio/:id/analise', async (req, res) => {
  try {
    if (!llm.isConfigured()) return res.status(503).json({ error: 'IA não configurada (ANTHROPIC_API_KEY). O diagnóstico do motor continua valendo.' });
    const { x, periodo } = await acharAnuncio(req);
    if (!x) return res.status(404).json({ error: 'anúncio não encontrado no Rankeamento' });
    res.json(await gerarIa(x, periodo, { force: !!req.body?.force, por: usuario(req) }));
  } catch (e) {
    console.error('[api/ia-estrategista/analise]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analisar prioritários em lote (só prioridade ≥ 40, no máx. LOTE_MAX, um por
// vez, pulando os que não mudaram desde a última análise).
router.post('/analise-lote', async (req, res) => {
  try {
    if (!llm.isConfigured()) return res.status(503).json({ error: 'IA não configurada (ANTHROPIC_API_KEY).' });
    const { periodo, storeId } = parse(req.body || {});
    const limite = Math.min(LOTE_MAX, Math.max(1, Number(req.body?.limite) || 10));
    const r = await carteira({ periodo, storeId });
    const alvo = r.anuncios.filter(x => x.prioridade.nota >= 40).slice(0, limite);
    let geradas = 0, reaproveitadas = 0; const erros = [];
    for (const x of alvo) {
      try { const g = await gerarIa(x, periodo, { por: usuario(req) }); g.cache === 'hit' ? reaproveitadas++ : geradas++; }
      catch (e) { erros.push({ ranking_ad_id: x.ranking_ad_id, erro: e.message }); }
    }
    res.json({ analisados: alvo.length, geradas, reaproveitadas, erros });
  } catch (e) {
    console.error('[api/ia-estrategista/analise-lote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Controle de execução das recomendações ──────────────────────────────────
// Antes × depois OBSERVADO de uma ação concluída: 14 dias fechados antes de
// executada_em vs. desde então, em taxa por dia (mesma janela de
// business_insights/Recuperação). Associação temporal, NÃO causalidade.
async function comAntesDepois(acoes) {
  const concl = acoes.filter(a => a.status === 'concluida' && a.executada_em);
  if (!concl.length) return acoes;
  const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
  const adIds = [...new Set(concl.map(a => a.ranking_ad_id))];
  const { rows: itens } = await pool.query(
    `SELECT id AS ranking_ad_id, ml_id FROM ranking_ads WHERE id = ANY($1::int[])
     UNION SELECT ranking_ad_id, ml_id FROM ranking_ad_links WHERE ranking_ad_id = ANY($1::int[])`, [adIds]);
  const itemParaAd = new Map(itens.map(i => [i.ml_id, i.ranking_ad_id]));
  const desde = new Date(Math.min(...concl.map(a => new Date(a.executada_em).getTime())) - 15 * 86400000).toISOString();
  const [{ rows: pedidos }, { rows: visitas }] = await Promise.all([
    pool.query(`${VENDA_DETALHE_SELECT} WHERE o.status <> 'cancelled' AND o.date_created >= $1 AND o.item_id = ANY($2::text[]) LIMIT 50000`, [desde, [...itemParaAd.keys()]]),
    pool.query(`SELECT item_id, date, visits FROM item_visits WHERE item_id = ANY($1::text[]) AND date >= $2::date`, [[...itemParaAd.keys()], desde.slice(0, 10)]),
  ]);
  const linhas = pedidos.map(p => ({ ...calcularMargemLinha(p, impostoFlexAtivo, freteMotoboy), ad: itemParaAd.get(p.item_id), t: new Date(p.date_created).getTime() }));
  const vis = visitas.map(v => ({ ad: itemParaAd.get(v.item_id), t: new Date(v.date).getTime(), n: Number(v.visits) || 0 }));
  const agora = Date.now();
  return acoes.map(a => {
    if (a.status !== 'concluida' || !a.executada_em) return a;
    const t0 = new Date(a.executada_em).getTime();
    const diasDepois = Math.max(1, (agora - t0) / 86400000);
    const janela = (ini, fim, dias) => {
      const ls = linhas.filter(l => l.ad === a.ranking_ad_id && l.t >= ini && l.t < fim);
      const fat = ls.reduce((s, l) => s + (Number(l.faturamento) || 0), 0), mg = ls.reduce((s, l) => s + l.margem, 0);
      const v = vis.filter(x => x.ad === a.ranking_ad_id && x.t >= ini && x.t < fim).reduce((s, x) => s + x.n, 0);
      return { pedidos_dia: +(ls.length / dias).toFixed(2), fat_dia: +(fat / dias).toFixed(2), margem_dia: +(mg / dias).toFixed(2), mc_pct: fat > 0 ? +((mg / fat) * 100).toFixed(1) : null, conversao: v > 0 ? +((ls.length / v) * 100).toFixed(2) : null };
    };
    return { ...a, antes_depois: { antes: janela(t0 - 14 * 86400000, t0, 14), depois: janela(t0, agora, diasDepois), dias_depois: Math.floor(diasDepois),
      aviso: 'Efeito OBSERVADO depois da ação (associação temporal) — NÃO prova que a ação causou a mudança.' } };
  });
}

router.get('/acoes', async (req, res) => {
  try {
    const p = []; const w = [];
    if (STATUS.includes(req.query.status)) { p.push(req.query.status); w.push(`status = $${p.length}`); }
    if (req.query.ranking_ad_id) { p.push(Number(req.query.ranking_ad_id)); w.push(`ranking_ad_id = $${p.length}`); }
    const { rows } = await pool.query(`SELECT * FROM ia_estrategista_acoes ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE status WHEN 'em_execucao' THEN 0 WHEN 'pendente' THEN 1 WHEN 'concluida' THEN 2 ELSE 3 END, updated_at DESC LIMIT 200`, p);
    res.json({ acoes: await comAntesDepois(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/acoes', async (req, res) => {
  try {
    const b = req.body || {};
    const acao = String(b.acao || '').trim();
    if (!acao || !Number(b.ranking_ad_id)) return res.status(400).json({ error: 'ranking_ad_id e acao são obrigatórios' });
    const status = STATUS.includes(b.status) ? b.status : 'pendente';
    const { rows: ad } = await pool.query(`SELECT ra.ml_id, COALESCE(i.title, ra.title) AS titulo FROM ranking_ads ra LEFT JOIN items i ON i.ml_id = ra.ml_id WHERE ra.id = $1`, [Number(b.ranking_ad_id)]);
    if (!ad[0]) return res.status(404).json({ error: 'anúncio não encontrado no Rankeamento' });
    const { rows } = await pool.query(
      `INSERT INTO ia_estrategista_acoes (ranking_ad_id, ml_id, produto, analise_id, categoria, problema, acao, responsavel, status, observacao, executada_em, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $9 = 'concluida' THEN now() END, $11) RETURNING *`,
      [Number(b.ranking_ad_id), ad[0].ml_id, ad[0].titulo, b.analise_id ? Number(b.analise_id) : null, b.categoria ? String(b.categoria).slice(0, 40) : null,
       b.problema ? String(b.problema).slice(0, 1000) : null, acao.slice(0, 1000), b.responsavel ? String(b.responsavel).slice(0, 120) : usuario(req),
       status, b.observacao ? String(b.observacao).slice(0, 2000) : null, usuario(req)]);
    res.json({ acao: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// status/responsável/observação/resultado. executada_em: carimbado só na
// transição PARA 'concluida'; some se sair de 'concluida' (nova janela depois).
router.patch('/acoes/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [req.params.id];
    if (b.status != null) {
      if (!STATUS.includes(b.status)) return res.status(400).json({ error: `status inválido (${STATUS.join(', ')})` });
      vals.push(b.status); const n = vals.length;
      sets.push(`executada_em = CASE WHEN $${n} = 'concluida' AND status IS DISTINCT FROM 'concluida' THEN now() WHEN $${n} = 'concluida' THEN executada_em ELSE NULL END`);
      sets.push(`status = $${n}`);
    }
    for (const [campo, max] of [['responsavel', 120], ['observacao', 2000], ['resultado_observado', 2000]]) {
      if (Object.prototype.hasOwnProperty.call(b, campo)) { vals.push(b[campo] == null || b[campo] === '' ? null : String(b[campo]).slice(0, max)); sets.push(`${campo} = $${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const { rows } = await pool.query(`UPDATE ia_estrategista_acoes SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'ação não encontrada' });
    res.json({ acao: (await comAntesDepois(rows))[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
