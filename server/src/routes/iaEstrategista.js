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
const llm = require('../ai/llm');
const narrativa = require('../ai/iaEstrategistaNarrativa');
const { parse, carteira, comAntesDepois } = require('../iaEstrategistaDados');

const router = express.Router();
const ANALISE_IA_VALIDADE_H = 24;   // mesma entrada dentro disso → devolve a salva
const LOTE_MAX = 20;                // teto de anúncios por "analisar prioritários"
const STATUS = ['pendente', 'em_execucao', 'concluida', 'descartada'];

const usuario = req => req.staffUser?.username || null;

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
      sets.push(`status_desde = CASE WHEN $${n} IS DISTINCT FROM status THEN now() ELSE status_desde END`);
      sets.push(`status = $${n}`);
      // concluída de novo = nova janela; o resultado automático pode sair outra vez
      sets.push(`resultado_auto_em = CASE WHEN $${n} = 'concluida' AND status IS DISTINCT FROM 'concluida' THEN NULL ELSE resultado_auto_em END`);
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
