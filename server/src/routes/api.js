// REST API — the ONLY interface the frontend is allowed to call.
// Every handler reads from PostgreSQL (optionally cached in Redis).
// None of these handlers call the Mercado Livre API directly.
const express = require('express');
const pool = require('../db/pool');
const redis = require('../db/redis');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────
async function cached(key, ttlSeconds, fn) {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const value = await fn();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}

function fmt(v) { return Number(v) || 0; }

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get('/dashboard/kpis', async (req, res) => {
  try {
    const data = await cached('kpis:summary', 30, async () => {
      const [today, perguntas, anuncios, alertas] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) vendas
           FROM orders
           WHERE date_created::date = CURRENT_DATE AND status != 'cancelled'`
        ),
        pool.query(`SELECT COUNT(*) n FROM questions WHERE status='UNANSWERED'`),
        pool.query(`SELECT COUNT(*) n FROM items WHERE status='active'`),
        pool.query(
          `SELECT COUNT(*) n FROM items WHERE status='active' AND available_quantity <= 5`
        ),
      ]);
      return {
        vendas_hoje:         fmt(today.rows[0].vendas),
        pedidos_hoje:        fmt(today.rows[0].pedidos),
        perguntas_pendentes: fmt(perguntas.rows[0].n),
        anuncios_ativos:     fmt(anuncios.rows[0].n),
        alertas_ativos:      fmt(alertas.rows[0].n),
      };
    });
    res.json(data);
  } catch (err) {
    console.error('[api] /dashboard/kpis', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard/chart', async (req, res) => {
  const period = Math.min(Number(req.query.period) || 7, 90);
  try {
    const { rows } = await pool.query(
      `SELECT date_created::date AS data,
              COUNT(*) pedidos,
              COALESCE(SUM(total_amount), 0) bruto
       FROM orders
       WHERE date_created >= CURRENT_DATE - $1::int
         AND status != 'cancelled'
       GROUP BY 1 ORDER BY 1`,
      [period]
    );
    res.json({
      rows: rows.map(r => ({
        data:    r.data,
        pedidos: fmt(r.pedidos),
        bruto:   fmt(r.bruto),
        liquido: fmt(r.bruto) * 0.88,
        taxas:   fmt(r.bruto) * 0.12,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard/top-products', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const { rows } = await pool.query(
      `SELECT ml_id, title, sold_quantity, price,
              (sold_quantity * price) AS revenue, status
       FROM items
       WHERE status = 'active'
       ORDER BY sold_quantity DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ml_id, title, available_quantity
       FROM items
       WHERE status = 'active' AND available_quantity <= 5
       ORDER BY available_quantity ASC
       LIMIT 10`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anúncios / Produtos ────────────────────────────────────────────────────
router.get('/anuncios', async (req, res) => {
  const { status = '', search = '', page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT ml_id, title, price, available_quantity, sold_quantity, status, updated_at
         FROM items
         WHERE ($1 = '' OR status = $1)
           AND ($2 = '' OR title ILIKE '%'||$2||'%')
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [status, search, Number(limit), offset]
      ),
      pool.query(
        `SELECT COUNT(*) total,
                COUNT(*) FILTER (WHERE status='active')  active,
                COUNT(*) FILTER (WHERE status='paused')  paused,
                COUNT(*) FILTER (WHERE status='closed')  closed
         FROM items`
      ),
    ]);
    res.json({ results: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ml_id AS id, title, price, available_quantity AS stock,
              sold_quantity AS sold, status
       FROM items
       ORDER BY sold_quantity DESC NULLS LAST
       LIMIT 100`
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/produtos/performance', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ml_id, title, visits, sold_quantity AS sales,
              position,
              CASE WHEN visits > 0
                   THEN ROUND((sold_quantity::numeric / visits) * 100, 2)
                   ELSE 0 END AS conversion_rate
       FROM items
       WHERE status = 'active'
       ORDER BY sold_quantity DESC NULLS LAST
       LIMIT 50`
    );
    const totals = await pool.query(
      `SELECT COALESCE(SUM(visits),0) total_visits,
              CASE WHEN SUM(visits)>0
                   THEN ROUND(SUM(sold_quantity)::numeric/SUM(visits)*100,2)
                   ELSE 0 END conversion_rate
       FROM items WHERE status='active'`
    );
    const s = totals.rows[0];
    res.json({
      items: rows,
      summary: {
        total_visits:    fmt(s.total_visits),
        conversion_rate: fmt(s.conversion_rate),
        avg_ctr:         null,
        roi:             null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pedidos / Vendas ───────────────────────────────────────────────────────
router.get('/pedidos', async (req, res) => {
  const { status = '', dateFrom, dateTo } = req.query;
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT ml_id AS id, buyer_nickname, title, total_amount, status, date_created
         FROM orders
         WHERE ($1 = '' OR status = $1)
           AND ($2::date IS NULL OR date_created::date >= $2::date)
           AND ($3::date IS NULL OR date_created::date <= $3::date)
         ORDER BY date_created DESC
         LIMIT 200`,
        [status, dateFrom || null, dateTo || null]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE date_created::date = CURRENT_DATE AND status != 'cancelled') total_hoje,
           COUNT(*) FILTER (WHERE status = 'ready_to_ship')  aguardando_envio,
           COUNT(*) FILTER (WHERE status = 'shipped')        em_transito,
           COUNT(*) FILTER (WHERE status = 'delivered'
             AND date_created::date = CURRENT_DATE)          entregues_hoje
         FROM orders`
      ),
    ]);
    res.json({ results: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vendas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount) FILTER (WHERE date_created::date = CURRENT_DATE), 0)         hoje,
         COALESCE(SUM(total_amount) FILTER (WHERE date_trunc('month', date_created) = date_trunc('month', CURRENT_DATE)), 0) mes_atual,
         COALESCE(SUM(total_amount) FILTER (WHERE date_trunc('month', date_created) = date_trunc('month', CURRENT_DATE - interval '1 month')), 0) mes_anterior,
         CASE WHEN COUNT(*) FILTER (WHERE status != 'cancelled') > 0
              THEN SUM(total_amount) FILTER (WHERE status != 'cancelled') /
                   COUNT(*) FILTER (WHERE status != 'cancelled')
              ELSE 0 END ticket_medio
       FROM orders
       WHERE status != 'cancelled'`
    );
    res.json({ summary: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vendas/diarias', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT date_created::date AS data,
                COUNT(*) pedidos,
                COALESCE(SUM(total_amount), 0) bruto
         FROM orders
         WHERE date_created >= CURRENT_DATE - $1::int
           AND status != 'cancelled'
         GROUP BY 1 ORDER BY 1`,
        [days]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(total_amount) FILTER (WHERE date_created::date = CURRENT_DATE), 0) hoje,
           COALESCE(SUM(total_amount) FILTER (WHERE date_trunc('month',date_created)=date_trunc('month',CURRENT_DATE)), 0) mes_atual,
           COALESCE(SUM(total_amount) FILTER (WHERE date_trunc('month',date_created)=date_trunc('month',CURRENT_DATE - interval '1 month')), 0) mes_anterior,
           CASE WHEN COUNT(*) FILTER (WHERE status!='cancelled')>0
                THEN SUM(total_amount) FILTER (WHERE status!='cancelled')/COUNT(*) FILTER (WHERE status!='cancelled')
                ELSE 0 END ticket_medio
         FROM orders WHERE status!='cancelled'`
      ),
    ]);
    res.json({
      rows: rows.rows.map(r => ({
        data:    r.data,
        pedidos: fmt(r.pedidos),
        bruto:   fmt(r.bruto),
        liquido: fmt(r.bruto) * 0.88,
        taxas:   fmt(r.bruto) * 0.12,
      })),
      summary: summary.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Perguntas / Mensagens ──────────────────────────────────────────────────
router.get('/perguntas', async (req, res) => {
  const { status = 'UNANSWERED' } = req.query;
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT ml_id AS id, item_id, item_title, text, answer_text, status, date_created
         FROM questions
         WHERE ($1 = '' OR status = $1)
         ORDER BY date_created DESC
         LIMIT 100`,
        [status]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='UNANSWERED')                                   unanswered,
           COUNT(*) FILTER (WHERE status='ANSWERED' AND answered_at::date=CURRENT_DATE)  answered_today,
           COUNT(*)                                                                       total,
           ROUND(AVG(EXTRACT(EPOCH FROM (answered_at - date_created))/3600)
                 FILTER (WHERE answered_at IS NOT NULL), 1)                              avg_response_hours
         FROM questions`
      ),
    ]);
    const s = summary.rows[0];
    res.json({
      questions: rows.rows,
      summary: {
        unanswered:        fmt(s.unanswered),
        answered_today:    fmt(s.answered_today),
        total:             fmt(s.total),
        avg_response_time: s.avg_response_hours || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/perguntas/:id/responder', async (req, res) => {
  try {
    await pool.query(
      `UPDATE questions
       SET answer_text=$2, status='ANSWERED', answered_at=now(), updated_at=now()
       WHERE ml_id=$1`,
      [req.params.id, req.body.text]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/mensagens', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pack_id, buyer_nickname, last_message, unread, last_message_date
       FROM messages
       ORDER BY last_message_date DESC NULLS LAST
       LIMIT 50`
    );
    res.json({ conversations: rows, summary: { total: rows.length, unread: rows.filter(r => r.unread > 0).length } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Clientes ───────────────────────────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  const { search = '' } = req.query;
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT buyer_nickname AS nickname,
                COUNT(*)               total_orders,
                SUM(total_amount)      total_spent,
                MAX(date_created)      last_order_date
         FROM orders
         WHERE status != 'cancelled'
           AND ($1 = '' OR buyer_nickname ILIKE '%'||$1||'%')
         GROUP BY buyer_nickname
         ORDER BY total_spent DESC NULLS LAST
         LIMIT 100`,
        [search]
      ),
      pool.query(
        `SELECT
           COUNT(DISTINCT buyer_nickname)                                                          total,
           COUNT(DISTINCT buyer_nickname) FILTER (WHERE date_trunc('month',date_created)=date_trunc('month',CURRENT_DATE)) new_this_month,
           COUNT(DISTINCT buyer_nickname) FILTER (WHERE (SELECT COUNT(*) FROM orders o2 WHERE o2.buyer_nickname=orders.buyer_nickname AND o2.status!='cancelled')>1) returning,
           CASE WHEN COUNT(*) FILTER(WHERE status!='cancelled')>0
                THEN SUM(total_amount) FILTER(WHERE status!='cancelled')/COUNT(*) FILTER(WHERE status!='cancelled')
                ELSE 0 END avg_ticket
         FROM orders WHERE status!='cancelled'`
      ),
    ]);
    res.json({ clients: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lojas ──────────────────────────────────────────────────────────────────
router.get('/lojas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, level_id, active_listings, monthly_revenue, updated_at
       FROM stores ORDER BY id`
    );
    res.json({ stores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Métricas / Reputação ───────────────────────────────────────────────────
router.get('/metricas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, level_id, reputation_data, active_listings, monthly_revenue
       FROM stores LIMIT 1`
    );
    if (!rows.length) return res.json({ level_id: null, metrics: {}, transactions: {} });
    const s = rows[0];
    const rep = s.reputation_data || {};
    res.json({
      level_id:     s.level_id,
      metrics:      rep.metrics || {},
      transactions: rep.transactions || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Análises ───────────────────────────────────────────────────────────────
router.get('/analises/horarios', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM date_created)::int AS hour,
              COUNT(*) orders,
              COALESCE(SUM(total_amount), 0) revenue
       FROM orders
       WHERE status != 'cancelled'
         AND date_created >= CURRENT_DATE - 30
       GROUP BY 1 ORDER BY 1`
    );
    res.json({ hours: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analises/dias-semana', async (req, res) => {
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(DOW FROM date_created)::int AS dow,
              COUNT(*) orders,
              COALESCE(SUM(total_amount), 0) revenue
       FROM orders
       WHERE status != 'cancelled'
         AND date_created >= CURRENT_DATE - 90
       GROUP BY 1 ORDER BY 1`
    );
    res.json({ days: rows.map(r => ({ ...r, label: DAYS[r.dow] })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Publicidade ────────────────────────────────────────────────────────────
router.get('/publicidade', async (req, res) => {
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT item_id, title, impressions, clicks, spend, revenue
         FROM ads_campaigns
         WHERE date = CURRENT_DATE
         ORDER BY spend DESC LIMIT 50`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(spend) FILTER (WHERE date=CURRENT_DATE), 0)   spend_today,
           COALESCE(SUM(revenue) FILTER (WHERE date=CURRENT_DATE), 0) revenue_today,
           COUNT(*) FILTER (WHERE date=CURRENT_DATE)                  sponsored_count
         FROM ads_campaigns`
      ),
    ]);
    const s = summary.rows[0];
    const acos = s.revenue_today > 0
      ? ((s.spend_today / s.revenue_today) * 100).toFixed(1)
      : null;
    res.json({
      campaigns: rows.rows,
      summary: { spend_today: fmt(s.spend_today), revenue_today: fmt(s.revenue_today), acos, sponsored_count: fmt(s.sponsored_count) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Concorrentes ───────────────────────────────────────────────────────────
router.get('/concorrentes', async (req, res) => {
  // Populated by the scheduler (syncConcorrentes). Returns empty when not yet synced.
  res.json({ competitors: [], summary: {} });
});

// ── Comparativos ───────────────────────────────────────────────────────────
router.get('/comparativos/periodos', async (req, res) => {
  const { p1 = '30', p2 = '60' } = req.query;
  try {
    const mk = (daysAgo, daysRange) => pool.query(
      `SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
              CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END ticket
       FROM orders
       WHERE date_created::date BETWEEN CURRENT_DATE - $1::int AND CURRENT_DATE - $2::int
         AND status != 'cancelled'`,
      [Number(daysAgo), Number(p1)]
    );
    const [per1, per2] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
                CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END ticket
         FROM orders
         WHERE date_created::date >= CURRENT_DATE - $1::int
           AND status != 'cancelled'`,
        [Number(p1)]
      ),
      pool.query(
        `SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
                CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END ticket
         FROM orders
         WHERE date_created::date BETWEEN CURRENT_DATE - $1::int AND CURRENT_DATE - $2::int
           AND status != 'cancelled'`,
        [Number(p2), Number(p1)]
      ),
    ]);
    res.json({ periodo1: per1.rows[0], periodo2: per2.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/comparativos/evolucao', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  try {
    const { rows } = await pool.query(
      `SELECT date_created::date AS data,
              COUNT(*) pedidos,
              COALESCE(SUM(total_amount), 0) receita
       FROM orders
       WHERE date_created >= CURRENT_DATE - $1::int
         AND status != 'cancelled'
       GROUP BY 1 ORDER BY 1`,
      [days]
    );
    res.json({ rows: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/comparativos/curva-abc', async (req, res) => {
  try {
    const { rows: all } = await pool.query(
      `SELECT ml_id, title,
              sold_quantity * price AS revenue,
              sold_quantity
       FROM items
       WHERE status = 'active' AND sold_quantity > 0
       ORDER BY revenue DESC NULLS LAST`
    );

    const totalRev = all.reduce((s, r) => s + fmt(r.revenue), 0);
    let cumSum = 0;
    const items = all.map(r => {
      cumSum += fmt(r.revenue);
      const cumPct = totalRev > 0 ? (cumSum / totalRev) * 100 : 0;
      return {
        ml_id:      r.ml_id,
        title:      r.title,
        revenue:    fmt(r.revenue),
        cumulative: Number(cumPct.toFixed(2)),
        class:      cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C',
      };
    });

    res.json({
      items,
      summary: {
        count_a: items.filter(i => i.class === 'A').length,
        count_b: items.filter(i => i.class === 'B').length,
        count_c: items.filter(i => i.class === 'C').length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Alertas ────────────────────────────────────────────────────────────────
router.get('/alertas/reposicao', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ml_id, title, available_quantity AS stock,
              COALESCE(sold_quantity::float / 30, 0) AS daily_sales
       FROM items
       WHERE status = 'active' AND available_quantity <= 15
       ORDER BY available_quantity ASC`
    );
    res.json({ items: rows, summary: { total: rows.length, critico: rows.filter(r => r.stock <= 3).length } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/alertas/cancelamentos', async (req, res) => {
  const { limit = 100 } = req.query;
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT ml_id AS order_id, buyer_nickname, title, total_amount AS amount,
                cancelled_by, cancel_reason AS reason, date_closed AS date
         FROM orders
         WHERE status = 'cancelled'
         ORDER BY date_closed DESC NULLS LAST
         LIMIT $1`,
        [Number(limit)]
      ),
      pool.query(
        `SELECT
           COUNT(*) total,
           COUNT(*) FILTER (WHERE date_closed::date = CURRENT_DATE) hoje,
           COALESCE(SUM(total_amount), 0) valor_total
         FROM orders WHERE status='cancelled'`
      ),
    ]);
    res.json({ items: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/alertas/devolucoes', async (req, res) => {
  try {
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT r.id, r.order_id, r.title, r.reason, r.amount, r.status, r.date
         FROM returns r
         ORDER BY r.date DESC NULLS LAST
         LIMIT 100`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='analysis')  in_analysis,
           COUNT(*) FILTER (WHERE status='approved')  approved,
           COUNT(*) FILTER (WHERE status='rejected')  rejected,
           COALESCE(SUM(amount), 0)                   total_value
         FROM returns`
      ),
    ]);
    res.json({ items: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/alertas/anuncios-problema', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ml_id, title, status, available_quantity, updated_at
       FROM items
       WHERE status IN ('paused','closed')
         OR (status = 'active' AND available_quantity = 0)
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 100`
    );
    res.json({
      items: rows.map(r => ({
        ...r,
        problema: r.status === 'paused' ? 'Pausado'
                : r.status === 'closed' ? 'Encerrado'
                : 'Sem estoque',
      })),
      summary: { total: rows.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Webhooks ───────────────────────────────────────────────────────────────
router.get('/webhooks/logs', async (req, res) => {
  const { topic = '', limit = 50 } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT topic, resource, store_id, status, error, received_at, processed_at
       FROM webhook_logs
       WHERE ($1 = '' OR topic = $1)
       ORDER BY received_at DESC
       LIMIT $2`,
      [topic, Number(limit)]
    );
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/webhooks/config', async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT
         COUNT(*) total,
         COUNT(*) FILTER (WHERE status='processed') processed,
         COUNT(*) FILTER (WHERE status='failed')    failed,
         COUNT(*) FILTER (WHERE status='pending')   pending
       FROM webhook_logs
       WHERE received_at::date = CURRENT_DATE`
    );
    const c = counts.rows[0];
    res.json({
      received_today:     fmt(c.total),
      processed_today:    fmt(c.processed),
      failed_today:       fmt(c.failed),
      queue_size:         fmt(c.pending),
      telegram_connected: !!process.env.TELEGRAM_BOT_TOKEN,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhooks/config', async (_req, res) => {
  res.json({ ok: true });
});

// ── Schedule ───────────────────────────────────────────────────────────────
router.get('/schedule/jobs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, cron, last_run, duration_ms, status FROM schedule_jobs ORDER BY name`
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/schedule/jobs/:name/trigger', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO schedule_jobs (name, status) VALUES ($1, 'queued')
       ON CONFLICT (name) DO UPDATE SET status='queued'`,
      [req.params.name]
    );
    res.json({ ok: true, job: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
