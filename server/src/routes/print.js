// Print Agent — rotas de GESTÃO (staff), montadas em /api/print (atrás do gate).
// Aqui o dashboard enfileira um job de impressão e cadastra/lista estações.
// As rotas consumidas pelo AGENTE ficam em routes/printAgent.js (auth por token).
// Ver .claude/print-agent.md.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const wsHub = require('../ws/hub');

const router = express.Router();

// Resolve a estação de um job: usa station_id se veio; senão a estação da
// loja; senão a estação GLOBAL (store_id NULL). Quando há mais de uma
// candidata no mesmo nível (ex.: 2 PCs de expedição, ambos globais), escolhe
// a de `last_seen` mais recente — NUNCA a de menor id "por acaso". Bug real:
// com 2 estações globais, a de menor id (cadastrada primeiro) sempre vencia
// mesmo com o agente dela offline há semanas, enquanto a estação de verdade
// ativa (id maior, agente rodando) nunca recebia job nenhum no automático —
// só era alcançável selecionando ela manualmente no seletor da tela de
// Embalagem. `NULLS LAST` pra uma estação recém-cadastrada (nunca fez poll
// ainda) não furar na frente de uma que já provou estar viva.
async function resolveStationId({ station_id, store_id }) {
  if (station_id) return Number(station_id);
  if (store_id) {
    const { rows } = await pool.query(
      `SELECT id FROM print_stations WHERE store_id=$1 ORDER BY last_seen DESC NULLS LAST, id LIMIT 1`, [store_id]
    );
    if (rows[0]) return rows[0].id;
  }
  // Fallback: estação "global" (store_id NULL) — pode haver mais de uma.
  const { rows } = await pool.query(
    `SELECT id FROM print_stations WHERE store_id IS NULL ORDER BY last_seen DESC NULLS LAST, id LIMIT 1`
  );
  return rows[0] ? rows[0].id : null;
}

// POST /api/print/jobs — enfileira uma etiqueta pra impressão automática.
// Body: { shipping_id, station_id?, store_id?, label:{product_name,variation_type,sku,store_name,company_name} }
// Publica WS `print:{station_id}` pra o agente acordar na hora (o agente também
// faz polling de GET /print-agent/jobs/next como caminho garantido).
router.post('/jobs', async (req, res) => {
  try {
    const { shipping_id, station_id, store_id, label } = req.body || {};
    if (!shipping_id) return res.status(400).json({ error: 'shipping_id é obrigatório' });
    const stationId = await resolveStationId({ station_id, store_id });
    if (!stationId) return res.status(409).json({ error: 'nenhuma estação de impressão configurada para essa loja — cadastre em /api/print/stations' });

    const { rows } = await pool.query(
      `INSERT INTO print_jobs (station_id, store_id, shipping_id, label, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING id, station_id, status`,
      [stationId, store_id || null, String(shipping_id), label || {}]
    );
    const job = rows[0];
    // sinal em tempo real (o agente filtra pelo tópico da sua estação)
    wsHub.publish(`print:${job.station_id}`, { jobId: job.id, shipping_id }).catch(() => {});
    res.json(job);
  } catch (e) {
    console.error('[api/print] POST /jobs', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/print/jobs — monitorar a fila (últimos jobs).
router.get('/jobs', async (req, res) => {
  try {
    const { status, station_id, limit } = req.query;
    const where = [], params = [];
    if (status) { params.push(status); where.push(`j.status = $${params.length}`); }
    if (station_id) { params.push(station_id); where.push(`j.station_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(Number(limit) || 50, 200));
    const { rows } = await pool.query(
      `SELECT j.id, j.station_id, s.name AS station_name, j.store_id, j.shipping_id,
              j.status, j.attempts, j.error, j.created_at, j.printed_at
         FROM print_jobs j
         LEFT JOIN print_stations s ON s.id = j.station_id
         ${whereSql}
        ORDER BY j.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/print] GET /jobs', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/print/stations — cadastra uma estação e devolve o TOKEN (mostrado 1x;
// é o segredo que o agente usa). Body: { name, store_id?, printer_name? }
router.post('/stations', async (req, res) => {
  try {
    const { name, store_id, printer_name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name é obrigatório' });
    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO print_stations (name, store_id, token, printer_name)
       VALUES ($1,$2,$3,$4) RETURNING id, name, store_id, printer_name, token, created_at`,
      [name, store_id || null, token, printer_name || null]
    );
    res.json(rows[0]); // token vai completo aqui — anote, não é mostrado de novo
  } catch (e) {
    console.error('[api/print] POST /stations', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/print/stations — lista estações (token mascarado).
router.get('/stations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.store_id, st.nickname AS store_nickname, s.printer_name,
              ('…' || right(s.token, 6)) AS token_hint, s.last_seen, s.created_at
         FROM print_stations s
         LEFT JOIN stores st ON st.id = s.store_id
        ORDER BY s.id`
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/print] GET /stations', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
