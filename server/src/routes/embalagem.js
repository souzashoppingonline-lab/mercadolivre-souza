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
              i.thumbnail, i.permalink, s.nickname AS store_nickname
       FROM orders o
       LEFT JOIN items i ON i.ml_id = o.item_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.shipping_id = $1
       ORDER BY o.date_created ASC`,
      [req.params.shippingId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nenhum pedido encontrado para essa etiqueta' });
    res.json({ shipping_id: req.params.shippingId, orders: rows });
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
    const { order_id, buyer, date_from, date_to } = req.query;
    const where = [];
    const params = [];
    if (order_id) { params.push(order_id); where.push(`$${params.length} = ANY(pv.order_ids)`); }
    if (date_from) { params.push(date_from); where.push(`pv.created_at >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`pv.created_at <= $${params.length}`); }
    if (buyer) { params.push(`%${buyer}%`); where.push(`ord.buyer_nickname ILIKE $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT pv.id, pv.shipping_id, pv.order_ids, pv.created_at, pv.duration_seconds,
              ord.title AS sample_title, ord.buyer_nickname AS sample_buyer
       FROM packing_videos pv
       LEFT JOIN LATERAL (
         SELECT title, buyer_nickname FROM orders WHERE ml_id = pv.order_ids[1]
       ) ord ON true
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
