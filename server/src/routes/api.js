// REST API — the ONLY interface the frontend is allowed to call.
// Every handler reads from PostgreSQL (optionally cached in Redis).
// None of these handlers call the Mercado Livre API.
const express = require('express');
const pool = require('../db/pool');
const redis = require('../db/redis');

const router = express.Router();

async function cached(key, ttlSeconds, fn) {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const value = await fn();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}

// ── Dashboard ──────────────────────────────────────────────
router.get('/dashboard/kpis', async (req, res) => {
  const data = await cached('kpis:summary', 30, async () => {
    const today = await pool.query(
      `SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) vendas
       FROM orders WHERE date_created::date = CURRENT_DATE AND status != 'cancelled'`
    );
    const perguntas = await pool.query(`SELECT COUNT(*) n FROM questions WHERE status='UNANSWERED'`);
    const anuncios = await pool.query(`SELECT COUNT(*) n FROM items WHERE status='active'`);
    return {
      vendas_hoje: Number(today.rows[0].vendas),
      pedidos_hoje: Number(today.rows[0].pedidos),
      perguntas_pendentes: Number(perguntas.rows[0].n),
      anuncios_ativos: Number(anuncios.rows[0].n),
    };
  });
  res.json(data);
});

router.get('/dashboard/alerts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT title, available_quantity FROM items WHERE status='active' AND available_quantity <= 5 ORDER BY available_quantity ASC LIMIT 10`
  );
  res.json(rows);
});

// ── Anúncios / Produtos ────────────────────────────────────
router.get('/anuncios', async (req, res) => {
  const { status = '', search = '', store_id = '' } = req.query;
  const { rows } = await pool.query(
    `SELECT ml_id, store_id, title, price, available_quantity, sold_quantity, status, updated_at
     FROM items
     WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR title ILIKE '%'||$2||'%')
       AND ($3 = '' OR store_id = $3::bigint)
     ORDER BY updated_at DESC LIMIT 100`,
    [status, search, store_id]
  );
  const summary = await pool.query(
    `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='active') active,
            COUNT(*) FILTER (WHERE status='paused') paused,
            COUNT(*) FILTER (WHERE status='closed') closed
     FROM items WHERE ($1 = '' OR store_id = $1::bigint)`,
    [store_id]
  );
  res.json({ results: rows, summary: summary.rows[0] });
});

router.get('/produtos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ml_id as id, title, price, available_quantity as stock, sold_quantity as sold, status FROM items ORDER BY sold_quantity DESC LIMIT 100`
  );
  res.json({ products: rows });
});

// ── Pedidos / Vendas ───────────────────────────────────────
router.get('/pedidos', async (req, res) => {
  const { status = '' } = req.query;
  const { rows } = await pool.query(
    `SELECT ml_id as id, buyer_nickname, title, total_amount, status, date_created
     FROM orders WHERE ($1 = '' OR status = $1) ORDER BY date_created DESC LIMIT 100`,
    [status]
  );
  res.json({ results: rows, summary: {} });
});

router.get('/vendas/diarias', async (req, res) => {
  const days = Number(req.query.days) || 30;
  const { rows } = await pool.query(
    `SELECT date_created::date as data, COUNT(*) pedidos, SUM(total_amount) bruto
     FROM orders WHERE date_created >= CURRENT_DATE - $1::int AND status != 'cancelled'
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  res.json({ rows: rows.map(r => ({ ...r, liquido: Number(r.bruto) * 0.88, taxas: Number(r.bruto) * 0.12 })), summary: {} });
});

// ── Perguntas / Mensagens ──────────────────────────────────
router.get('/perguntas', async (req, res) => {
  const { status = 'UNANSWERED' } = req.query;
  const { rows } = await pool.query(
    `SELECT ml_id as id, item_title, text, status, date_created FROM questions
     WHERE ($1 = '' OR status = $1) ORDER BY date_created DESC LIMIT 100`,
    [status]
  );
  res.json({ questions: rows, summary: {} });
});

router.post('/perguntas/:id/responder', express.json(), async (req, res) => {
  // Marks intent in DB; an outbound worker job should actually call ML to answer.
  await pool.query(`UPDATE questions SET answer_text=$2, status='ANSWERED', updated_at=now() WHERE ml_id=$1`, [req.params.id, req.body.text]);
  res.json({ ok: true });
});

router.get('/mensagens', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pack_id, buyer_nickname, last_message, unread, last_message_date FROM messages ORDER BY last_message_date DESC LIMIT 50`
  );
  res.json({ conversations: rows, summary: {} });
});

// ── Alertas ────────────────────────────────────────────────
router.get('/alertas/reposicao', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT title, available_quantity as stock,
            COALESCE(sold_quantity::float / 30, 0) as daily_sales
     FROM items WHERE status='active' AND available_quantity <= 15 ORDER BY available_quantity ASC`
  );
  res.json({ items: rows, summary: {} });
});

router.get('/alertas/cancelamentos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ml_id as order_id, title, total_amount as amount, cancelled_by, cancel_reason as reason, date_closed as date
     FROM orders WHERE status='cancelled' ORDER BY date_closed DESC LIMIT 100`
  );
  res.json({ items: rows, summary: {} });
});

// ── Lojas ──────────────────────────────────────────────────
router.get('/lojas', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nickname, level_id, active_listings, monthly_revenue,
            token_expires_at, updated_at,
            CASE WHEN token_expires_at > now() THEN true ELSE false END as token_valid
     FROM stores ORDER BY nickname`
  );
  res.json({ stores: rows });
});

// ── Webhooks / Schedule ────────────────────────────────────
router.get('/webhooks/logs', async (req, res) => {
  const { topic = '', limit = 50 } = req.query;
  const { rows } = await pool.query(
    `SELECT topic, resource, store_id, status, received_at FROM webhook_logs
     WHERE ($1 = '' OR topic = $1) ORDER BY received_at DESC LIMIT $2`,
    [topic, Number(limit)]
  );
  res.json({ logs: rows });
});

router.get('/webhooks/config', async (req, res) => {
  const counts = await pool.query(
    `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='processed') processed,
            COUNT(*) FILTER (WHERE status='failed') failed,
            COUNT(*) FILTER (WHERE status='pending') pending
     FROM webhook_logs WHERE received_at::date = CURRENT_DATE`
  );
  const c = counts.rows[0];
  res.json({
    received_today: Number(c.total), processed_today: Number(c.processed),
    failed_today: Number(c.failed), queue_size: Number(c.pending),
    telegram_connected: !!process.env.TELEGRAM_BOT_TOKEN,
  });
});

router.get('/schedule/jobs', async (req, res) => {
  const { rows } = await pool.query(`SELECT name, cron, last_run, duration_ms, status FROM schedule_jobs`);
  res.json({ jobs: rows });
});

module.exports = router;
