// Embalagem — bipagem de etiqueta (FLEX/Mercado Envios) + conferência em
// vídeo. Módulo independente: só lê `orders`/`items` (leitura, nunca
// escreve nelas) e escreve/lê `packing_videos`. Ver .claude/embalagem.md.
//
// A extração do `shipping_id` a partir do que foi bipado (JSON do QR ou
// string crua do barcode linear) acontece no FRONTEND — esta rota já
// recebe o shipping_id limpo.
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const pool = require('../db/pool');

const router = express.Router();

const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'embalagem-videos');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(STORAGE_ROOT, day);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const shippingId = String(req.body.shipping_id || 'sem-id').replace(/[^a-zA-Z0-9_-]/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${shippingId}_${stamp}.webm`);
  },
});
// Limite generoso (300MB) — gravação de conferência dura tipicamente 1-3min,
// bem abaixo disso; o limite é só uma trava de segurança.
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

// GET /api/embalagem/pedido/:shippingId — busca pedido(s) pela etiqueta bipada.
// Pode retornar mais de 1 linha: um mesmo envio (pack) pode agrupar vários
// pedidos do mesmo comprador.
router.get('/pedido/:shippingId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.ml_id AS order_id, o.item_id, o.title, o.quantity, o.buyer_nickname, o.store_id,
              o.unit_price, o.status, o.shipping_type, o.date_created,
              o.raw_data->'order_items'->0->'item'->>'seller_sku' AS seller_sku,
              o.raw_data->'order_items'->0->'item'->'variation_attributes' AS variation_attributes,
              i.thumbnail, i.permalink, i.available_quantity, s.nickname AS store_nickname
       FROM orders o
       LEFT JOIN items i ON i.ml_id = o.item_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.shipping_id = $1
       ORDER BY o.date_created ASC`,
      [req.params.shippingId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nenhum pedido encontrado para essa etiqueta' });

    // Verificação se essa etiqueta já foi bipada/gravada antes — não bloqueia,
    // só avisa o operador (ver pages/embalagem.html: confirm() antes de gravar de novo).
    const { rows: existing } = await pool.query(
      `SELECT id, created_at FROM packing_videos WHERE shipping_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.shippingId]
    );

    res.json({ shipping_id: req.params.shippingId, orders: rows, already_packed: existing[0] || null });
  } catch (e) {
    console.error('[api/embalagem] GET /pedido/:shippingId', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/embalagem/finalizar — recebe o vídeo gravado (multipart) e
// grava o registro. Campos de texto devem vir ANTES do arquivo no
// FormData, pra o multer já ter req.body.shipping_id disponível quando
// monta o nome/pasta do arquivo (destination/filename acima).
router.post('/finalizar', upload.single('video'), async (req, res) => {
  try {
    const { shipping_id, order_ids, duration_seconds, store_id } = req.body;
    if (!req.file) return res.status(400).json({ error: 'arquivo de vídeo ausente' });
    if (!shipping_id) return res.status(400).json({ error: 'shipping_id é obrigatório' });

    let orderIdsArr = [];
    try { orderIdsArr = JSON.parse(order_ids || '[]'); } catch (e) { orderIdsArr = []; }

    const { rows } = await pool.query(
      `INSERT INTO packing_videos (shipping_id, order_ids, file_path, duration_seconds, store_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [shipping_id, orderIdsArr, req.file.path, duration_seconds ? Number(duration_seconds) : null, store_id || null]
    );
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('[api/embalagem] POST /finalizar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/videos?order_id&buyer&date_from&date_to — consulta
// (usado tanto na aba "Buscar vídeos" quanto, no futuro, num botão em
// pages/devolucoes.html).
router.get('/videos', async (req, res) => {
  try {
    const { order_id, buyer, date_from, date_to, store_id } = req.query;
    const where = [];
    const params = [];
    if (order_id) { params.push(order_id); where.push(`$${params.length} = ANY(pv.order_ids)`); }
    if (store_id) { params.push(store_id); where.push(`pv.store_id = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`pv.created_at >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`pv.created_at <= $${params.length}`); }
    if (buyer) { params.push(`%${buyer}%`); where.push(`ord.buyer_nickname ILIKE $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT pv.id, pv.shipping_id, pv.order_ids, pv.created_at, pv.duration_seconds, pv.store_id,
              ord.title AS sample_title, ord.buyer_nickname AS sample_buyer, ord.shipping_type AS sample_shipping_type,
              s.nickname AS store_nickname
       FROM packing_videos pv
       LEFT JOIN LATERAL (
         SELECT title, buyer_nickname, shipping_type FROM orders WHERE ml_id = pv.order_ids[1]
       ) ord ON true
       LEFT JOIN stores s ON s.id = pv.store_id
       ${whereSql}
       ORDER BY pv.created_at DESC
       LIMIT 100`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/embalagem] GET /videos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/videos-por-pedidos?order_ids=1,2,3 — lookup em lote
// (usado por pages/devolucoes.html pra saber, sem N+1, quais pedidos de uma
// lista têm vídeo de embalagem gravado, e mostrar um botão "Assistir" direto
// na tela de devoluções). Devolve só os que têm vídeo — {order_id: {id, created_at}}.
// Quando um shipping_id agrupa mais de um vídeo (bipado 2x), fica o mais recente.
router.get('/videos-por-pedidos', async (req, res) => {
  try {
    const orderIds = String(req.query.order_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!orderIds.length) return res.json({});

    const { rows } = await pool.query(
      `SELECT id, order_ids, created_at
       FROM packing_videos
       WHERE order_ids && $1::text[]
       ORDER BY created_at DESC`,
      [orderIds]
    );

    const map = {};
    for (const row of rows) {
      for (const oid of row.order_ids) {
        if (orderIds.includes(oid) && !map[oid]) map[oid] = { id: row.id, created_at: row.created_at };
      }
    }
    res.json(map);
  } catch (e) {
    console.error('[api/embalagem] GET /videos-por-pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/por-hora?date=YYYY-MM-DD&store_id= — quantidade de
// bipagens por hora (0-23) num dia, sempre 24 posições (zero-fill) pra dar
// pra montar um gráfico de colunas comparando dois dias sem buraco no eixo.
// Mesmo padrão de fuso já usado no resto do sistema pra colunas TIMESTAMPTZ
// (AT TIME ZONE 'America/Sao_Paulo' antes de truncar — ver decisions.md).
router.get('/por-hora', async (req, res) => {
  try {
    const { date, store_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date é obrigatório (YYYY-MM-DD)' });

    const { rows } = await pool.query(
      `SELECT h.hour, COALESCE(COUNT(pv.id), 0)::int AS qty
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN packing_videos pv
         ON EXTRACT(HOUR FROM pv.created_at AT TIME ZONE 'America/Sao_Paulo') = h.hour
        AND pv.created_at >= ($1::date AT TIME ZONE 'America/Sao_Paulo')
        AND pv.created_at <  (($1::date + 1) AT TIME ZONE 'America/Sao_Paulo')
        AND ($2::bigint IS NULL OR pv.store_id = $2)
       GROUP BY h.hour
       ORDER BY h.hour`,
      [date, store_id || null]
    );
    res.json({ date, hours: rows });
  } catch (e) {
    console.error('[api/embalagem] GET /por-hora', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/historico?days=30&store_id= — série diária (zero-fill)
// pra enxergar tendência de produtividade ao longo do tempo, não só "hoje
// vs. ontem" (ver /por-hora acima). duration_sum/duration_orders (em vez de
// já devolver uma média pronta) seguem o mesmo padrão SUM/SUM do card
// "Tempo médio / pedido" da Conferência do Dia — soma total, não média das
// médias, calculado no frontend a partir desses dois números.
router.get('/historico', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const { store_id } = req.query;

    const { rows } = await pool.query(
      `SELECT d.day::date AS date,
              COUNT(pv.id)::int AS count,
              COALESCE(SUM(pv.duration_seconds) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::numeric AS duration_sum,
              COALESCE(SUM(cardinality(pv.order_ids)) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::int AS duration_orders
       FROM generate_series((current_date - ($1::int - 1))::timestamp, current_date::timestamp, interval '1 day') AS d(day)
       LEFT JOIN packing_videos pv
         ON pv.created_at >= (d.day AT TIME ZONE 'America/Sao_Paulo')
        AND pv.created_at <  ((d.day + interval '1 day') AT TIME ZONE 'America/Sao_Paulo')
        AND ($2::bigint IS NULL OR pv.store_id = $2)
       GROUP BY d.day
       ORDER BY d.day`,
      [days, store_id || null]
    );
    res.json({ days: rows });
  } catch (e) {
    console.error('[api/embalagem] GET /historico', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/videos/:id/file — stream do arquivo. res.sendFile já
// suporta Range requests nativamente (necessário pra dar play/scrub no
// player HTML5 sem baixar o vídeo inteiro de uma vez).
router.get('/videos/:id/file', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT file_path FROM packing_videos WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'vídeo não encontrado' });
    res.sendFile(path.resolve(rows[0].file_path), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'arquivo de vídeo não encontrado no disco' });
    });
  } catch (e) {
    console.error('[api/embalagem] GET /videos/:id/file', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
