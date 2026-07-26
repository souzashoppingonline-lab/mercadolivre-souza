// Análise de Produtos (Fase 1) — CRUD de produto + fila de "produto ativo para
// coleta". As rotas de coleta consumidas pela EXTENSÃO ficam públicas em
// routes/extensionCollect.js (antes do gate). Aqui é o lado do dashboard (staff).
// Ver .claude/analise-produtos.md.
const express = require('express');
const pool = require('../db/pool');

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
      `SELECT id, product_id, ml_id, titulo, preco, preco_original, nota, vendas, perguntas,
              comentarios, vendedor, cidade, estado, reputacao,
              is_full AS full, is_flex AS flex, fotos, videos, created_at
         FROM analise_product_ads WHERE product_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ produto: rows[0], anuncios, ativo_id: await getAtivoId() });
  } catch (e) { console.error('[api/analise] GET /produtos/:id', e.message); res.status(500).json({ error: e.message }); }
});

const num = (v) => (v === '' || v == null ? null : Number(v));

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

// POST /api/analise/produtos/:id/analisar — motor de IA (Fase 3). Stub por enquanto.
router.post('/produtos/:id/analisar', async (req, res) => {
  res.json({ ok: true, message: 'O motor de IA chega na Fase 3 — a coleta e o cadastro já estão prontos.' });
});

module.exports = router;
