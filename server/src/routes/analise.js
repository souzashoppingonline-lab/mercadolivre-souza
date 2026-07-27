// Análise de Produtos (Fase 1) — CRUD de produto + fila de "produto ativo para
// coleta". As rotas de coleta consumidas pela EXTENSÃO ficam públicas em
// routes/extensionCollect.js (antes do gate). Aqui é o lado do dashboard (staff).
// Ver .claude/analise-produtos.md.
const express = require('express');
const pool = require('../db/pool');
const wsHub = require('../ws/hub');
const { num, mapAd, adValues, upsertAd } = require('../analise/ads');
const llm = require('../ai/llm');
const { analisarNucleo, gerarCriativos } = require('../ai/analiseAgents');
const monitor = require('../analise/monitor');

const router = express.Router();

async function getAtivoId() {
  const { rows } = await pool.query(`SELECT product_id FROM analise_active_collection WHERE id=1`);
  return rows[0]?.product_id ?? null;
}

// GET /api/analise/produtos — lista + produto ativo + contagem de anúncios
router.get('/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              (SELECT count(*) FROM analise_product_ads a WHERE a.product_id = p.id)::int AS anuncios_count
         FROM analise_products p
        ORDER BY p.updated_at DESC`
    );
    res.json({ rows, ativo_id: await getAtivoId() });
  } catch (e) { console.error('[api/analise] GET /produtos', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/analise/produtos/:id — detalhe + anúncios coletados
router.get('/produtos/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM analise_products WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'produto não encontrado' });
    const { rows: anuncios } = await pool.query(
      `SELECT * FROM analise_product_ads WHERE product_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    const mapped = anuncios.map(mapAd);
    // Enriquece cada anúncio com o histórico de monitoramento (snapshots do MLB).
    const mlIds = mapped.map((a) => a.ml_id).filter(Boolean);
    if (mlIds.length) {
      const { rows: snaps } = await pool.query(
        `SELECT ml_id, snap_date, preco, preco_original, status, available_quantity,
                sold_quantity, sold_delta, visits_day
           FROM analise_monitor_snapshots
          WHERE ml_id = ANY($1) ORDER BY snap_date ASC`, [mlIds]);
      const byId = {};
      for (const s of snaps) (byId[s.ml_id] = byId[s.ml_id] || []).push(s);
      for (const a of mapped) {
        const h = a.ml_id && byId[a.ml_id];
        if (h && h.length) a.monitor = { historico: h, ultimo: h[h.length - 1], count: h.length };
      }
    }
    res.json({ produto: rows[0], anuncios: mapped, ativo_id: await getAtivoId() });
  } catch (e) { console.error('[api/analise] GET /produtos/:id', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/produtos — cadastrar
router.post('/produtos', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.produto) return res.status(400).json({ error: 'produto é obrigatório' });
    const { rows } = await pool.query(
      `INSERT INTO analise_products (produto,fornecedor,preco_compra,taxa_mp,imposto,frete_entrada,embalagem,observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.produto, b.fornecedor || null, num(b.preco_compra), num(b.taxa_mp), num(b.imposto), num(b.frete_entrada), num(b.embalagem), b.observacoes || null]
    );
    res.json(rows[0]);
  } catch (e) { console.error('[api/analise] POST /produtos', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/produtos/:id/editar
router.post('/produtos/:id/editar', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE analise_products SET produto=$2,fornecedor=$3,preco_compra=$4,taxa_mp=$5,imposto=$6,
              frete_entrada=$7,embalagem=$8,observacoes=$9,updated_at=now()
        WHERE id=$1 RETURNING *`,
      [req.params.id, b.produto, b.fornecedor || null, num(b.preco_compra), num(b.taxa_mp), num(b.imposto), num(b.frete_entrada), num(b.embalagem), b.observacoes || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'produto não encontrado' });
    res.json(rows[0]);
  } catch (e) { console.error('[api/analise] POST /produtos/:id/editar', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/produtos/:id/ativar — define como ÚNICO produto ativo de coleta
router.post('/produtos/:id/ativar', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`SELECT 1 FROM analise_products WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'produto não encontrado' });
    await pool.query(`UPDATE analise_active_collection SET product_id=$1, updated_at=now() WHERE id=1`, [req.params.id]);
    res.json({ ok: true, ativo_id: Number(req.params.id) });
  } catch (e) { console.error('[api/analise] ativar', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/produtos/:id/finalizar — limpa o ativo (encerra a coleta)
router.post('/produtos/:id/finalizar', async (req, res) => {
  try {
    await pool.query(`UPDATE analise_active_collection SET product_id=NULL, updated_at=now() WHERE id=1 AND product_id=$1`, [req.params.id]);
    res.json({ ok: true, ativo_id: null });
  } catch (e) { console.error('[api/analise] finalizar', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/produtos/:id/analisar — motor de IA (Fase 3, núcleo).
// Roda Score + Comentários + Financeiro + Decisão sobre os concorrentes coletados,
// grava o resultado no produto e devolve. Síncrono (mesmo padrão da IA Sócio
// Shopee) — a página mostra um spinner enquanto processa. Ver .claude/analise-produtos.md.
router.post('/produtos/:id/analisar', async (req, res) => {
  try {
    if (!llm.isConfigured()) {
      return res.status(503).json({ error: 'IA não configurada — cole a chave ANTHROPIC_API_KEY no .env do servidor e reinicie.' });
    }
    const { rows } = await pool.query(`SELECT * FROM analise_products WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'produto não encontrado' });
    const produto = rows[0];
    const { rows: adRows } = await pool.query(
      `SELECT * FROM analise_product_ads WHERE product_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    if (!adRows.length) return res.status(400).json({ error: 'colete pelo menos um concorrente antes de analisar' });

    const { result, score } = await analisarNucleo(produto, adRows.map(mapAd));
    const { rows: upd } = await pool.query(
      `UPDATE analise_products SET ai_result=$2, ai_score=$3, ai_analyzed_at=now(),
              status='ANALISADO', updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, JSON.stringify(result), score]);
    res.json({ ok: true, result, score, produto: upd[0] });
  } catch (e) {
    console.error('[api/analise] analisar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/analise/produtos/:id/monitorar-agora — consulta a API do ML AGORA
// pra cada MLB deste produto e grava o snapshot do dia (preço, estoque, vendas,
// visitas). O job diário faz isso sozinho; esta rota é o "atualizar já".
router.post('/produtos/:id/monitorar-agora', async (req, res) => {
  try {
    const r = await monitor.snapshotProduct(req.params.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[api/analise] monitorar-agora', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/analise/produtos/:id/criativos — gera 7 briefs de imagem (JSON) que
// quebram objeções dos comentários, pro usuário colar no ChatGPT. On-demand
// (mais caro que a análise) — botão separado. Ver .claude/analise-produtos.md.
router.post('/produtos/:id/criativos', async (req, res) => {
  try {
    if (!llm.isConfigured()) {
      return res.status(503).json({ error: 'IA não configurada — cole a chave ANTHROPIC_API_KEY no .env do servidor e reinicie.' });
    }
    const { rows } = await pool.query(`SELECT * FROM analise_products WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'produto não encontrado' });
    const { rows: adRows } = await pool.query(
      `SELECT * FROM analise_product_ads WHERE product_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    const { criativos } = await gerarCriativos(rows[0], adRows.map(mapAd));
    if (!criativos.length) return res.status(502).json({ error: 'a IA não devolveu criativos — tente de novo' });
    await pool.query(
      `UPDATE analise_products SET ai_creativos=$2, ai_creativos_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, JSON.stringify(criativos)]);
    res.json({ ok: true, criativos });
  } catch (e) {
    console.error('[api/analise] criativos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/analise/produtos/:id/anuncio — adiciona um concorrente MANUALMENTE.
// (A extensão usa a rota pública /extension/anuncio; esta é do dashboard/staff.)
router.post('/produtos/:id/anuncio', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`SELECT 1 FROM analise_products WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'produto não encontrado' });
    const ad = await upsertAd(req.params.id, req.body || {});
    wsHub.publish('analise_anuncio', { produto_id: Number(req.params.id), anuncio: ad }).catch(() => {});
    res.json(ad);
  } catch (e) { console.error('[api/analise] POST anuncio manual', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/anuncios/:adId/editar — completa/corrige campos à mão.
router.post('/anuncios/:adId/editar', async (req, res) => {
  try {
    const v = adValues(req.body || {});
    // fotos só sobrescreve se veio uma nova (COALESCE preserva a existente).
    const { rows } = await pool.query(
      `UPDATE analise_product_ads SET
         titulo=$2, preco=$3, preco_original=$4, nota=$5, vendas=$6, perguntas=$7, comentarios=$8,
         vendedor=$9, cidade=$10, estado=$11, reputacao=$12, is_full=$13, is_flex=$14,
         fotos=COALESCE($15, fotos), observacoes=$16, comentarios_texto=$17, comentarios_auto=$18,
         vendas_7d=$19, preco_medio_7d=$20, vendas_15d=$21, preco_medio_15d=$22,
         vendas_21d=$23, preco_medio_21d=$24, vendas_30d=$25, preco_medio_30d=$26,
         link=$27, ml_id=COALESCE($28, ml_id)
       WHERE id=$1 RETURNING *`,
      [req.params.adId, v.titulo, v.preco, v.preco_original, v.nota, v.vendas, v.perguntas, v.comentarios,
       v.vendedor, v.cidade, v.estado, v.reputacao, v.is_full, v.is_flex, v.fotos, v.observacoes, v.comentarios_texto, v.comentarios_auto,
       v.vendas_7d, v.preco_medio_7d, v.vendas_15d, v.preco_medio_15d, v.vendas_21d, v.preco_medio_21d, v.vendas_30d, v.preco_medio_30d,
       v.link, v.ml_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'anúncio não encontrado' });
    res.json(mapAd(rows[0]));
  } catch (e) { console.error('[api/analise] POST anuncio editar', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/anuncios/:adId/excluir — remove um card.
router.post('/anuncios/:adId/excluir', async (req, res) => {
  try {
    await pool.query(`DELETE FROM analise_product_ads WHERE id=$1`, [req.params.adId]);
    res.json({ ok: true });
  } catch (e) { console.error('[api/analise] POST anuncio excluir', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/analise/ia/gastos — gasto real da IA (por dia/mês/total) + estimativa
// de saldo. A API da Anthropic não expõe o saldo, então usamos o valor que o
// usuário informou (ai_settings) menos o que foi gasto desde então.
router.get('/ia/gastos', async (req, res) => {
  try {
    const { rows: agg } = await pool.query(`
      SELECT
        COALESCE(SUM(cost_usd),0)::float AS total,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date),0)::float AS hoje,
        COALESCE(SUM(cost_usd) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', now())),0)::float AS mes,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'),0)::float AS ultimos7,
        COALESCE(AVG(cost_usd) FILTER (WHERE feature='analise'),0)::float AS media_analise,
        COALESCE(AVG(cost_usd) FILTER (WHERE feature='criativos'),0)::float AS media_criativos,
        COUNT(*) FILTER (WHERE feature='analise')::int AS n_analises,
        COUNT(*) FILTER (WHERE feature='criativos')::int AS n_criativos
      FROM ai_usage_log`);
    const g = agg[0];
    const { rows: st } = await pool.query(`SELECT balance_usd, balance_set_at FROM ai_settings WHERE id=1`);
    const saldo = st[0]?.balance_usd != null ? Number(st[0].balance_usd) : null;
    const saldoDesde = st[0]?.balance_set_at || null;

    let restante = null, estAnalises = null, estDias = null, gastoDesde = 0;
    if (saldo != null) {
      const { rows: gd } = await pool.query(
        `SELECT COALESCE(SUM(cost_usd),0)::float AS s FROM ai_usage_log WHERE $1::timestamptz IS NULL OR created_at >= $1`,
        [saldoDesde]);
      gastoDesde = gd[0].s;
      restante = Math.max(0, saldo - gastoDesde);
      if (g.media_analise > 0) estAnalises = Math.floor(restante / g.media_analise);
      const porDia = g.ultimos7 / 7;
      if (porDia > 0) estDias = Math.floor(restante / porDia);
    }
    res.json({ ...g, saldo, saldo_set_at: saldoDesde, gasto_desde_saldo: gastoDesde,
               restante, est_analises: estAnalises, est_dias: estDias });
  } catch (e) { console.error('[api/analise] gastos', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/analise/ia/saldo — usuário informa o saldo atual (US$) do console.
router.post('/ia/saldo', async (req, res) => {
  try {
    const saldo = num((req.body || {}).saldo_usd);
    if (saldo == null || saldo < 0) return res.status(400).json({ error: 'saldo inválido' });
    await pool.query(`UPDATE ai_settings SET balance_usd=$1, balance_set_at=now() WHERE id=1`, [saldo]);
    res.json({ ok: true });
  } catch (e) { console.error('[api/analise] saldo', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
