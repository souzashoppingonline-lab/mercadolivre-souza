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

router.get('/vendas/detalhado', async (req, res) => {
  const { store_id = '', status = 'paid', days = 30, search = '' } = req.query;
  const { rows } = await pool.query(
    `SELECT
       o.ml_id, o.store_id, s.nickname as conta, o.item_id,
       o.title, o.quantity, o.unit_price,
       o.total_amount as faturamento,
       o.ml_fee as tarifa,
       o.shipping_type as frete_tipo,
       o.shipping_cost as frete_comprador,
       COALESCE(o.shipping_seller_cost, 0) as frete_vendedor,
       o.status, o.date_created,
       COALESCE(i.cost, 0) as custo,
       COALESCE(s.imposto_pct, 0) as imposto_pct
     FROM orders o
     JOIN stores s ON s.id = o.store_id
     LEFT JOIN items i ON i.ml_id = o.item_id
     WHERE ($1 = '' OR o.store_id = $1::bigint)
       AND ($2 = '' OR o.status = $2)
       AND o.date_created >= CURRENT_DATE - $3::int
       AND ($4 = '' OR o.title ILIKE '%'||$4||'%')
     ORDER BY o.date_created DESC LIMIT 500`,
    [store_id, status, Number(days), search]
  );

  const result = rows.map(r => {
    const fat = Number(r.faturamento) || 0;
    const custo = Number(r.custo) * (Number(r.quantity) || 1);
    const imposto = fat * (Number(r.imposto_pct) / 100);
    const tarifa = Number(r.tarifa) || 0;
    const freteVend = Number(r.frete_vendedor) || 0;
    const freteComp = Number(r.frete_comprador) || 0;
    const margem = fat - custo - imposto - tarifa - freteComp - freteVend;
    const mc_pct = fat > 0 ? (margem / fat) * 100 : 0;
    return { ...r, custo, imposto, freteVend, margem, mc_pct: Number(mc_pct.toFixed(2)) };
  });

  // Summary
  const approved = result.filter(r => r.status !== 'cancelled');
  const cancelled = result.filter(r => r.status === 'cancelled');
  const summary = {
    vendas_aprovadas: approved.reduce((a, r) => a + Number(r.faturamento), 0),
    vendas_canceladas: cancelled.reduce((a, r) => a + Number(r.faturamento), 0),
    custo_total: approved.reduce((a, r) => a + r.custo, 0),
    imposto_total: approved.reduce((a, r) => a + r.imposto, 0),
    tarifa_total: approved.reduce((a, r) => a + Number(r.tarifa), 0),
    frete_comprador_total: approved.reduce((a, r) => a + Number(r.frete_comprador), 0),
    frete_vendedor_total: approved.reduce((a, r) => a + (r.freteVend || 0), 0),
    margem_total: approved.reduce((a, r) => a + r.margem, 0),
    qtd_aprovadas: approved.reduce((a, r) => a + (Number(r.quantity) || 1), 0),
    qtd_canceladas: cancelled.reduce((a, r) => a + (Number(r.quantity) || 1), 0),
    pedidos_aprovados: approved.length,
    pedidos_cancelados: cancelled.length,
    ticket_medio: approved.length ? approved.reduce((a, r) => a + Number(r.faturamento), 0) / approved.length : 0,
  };
  summary.mc_pct = summary.vendas_aprovadas > 0 ? (summary.margem_total / summary.vendas_aprovadas) * 100 : 0;

  res.json({ rows: result, summary });
});

// ── Configuração de loja (imposto, etc.) ───────────────────
router.patch('/lojas/:id', async (req, res) => {
  const { imposto_pct } = req.body;
  if (imposto_pct == null) return res.status(400).json({ error: 'imposto_pct required' });
  await pool.query(`UPDATE stores SET imposto_pct=$2 WHERE id=$1`, [req.params.id, Number(imposto_pct)]);
  res.json({ ok: true });
});

router.patch('/items/:id/custo', async (req, res) => {
  const { cost } = req.body;
  if (cost == null) return res.status(400).json({ error: 'cost required' });
  await pool.query(`UPDATE items SET cost=$2 WHERE ml_id=$1`, [req.params.id, Number(cost)]);
  res.json({ ok: true });
});

// ── SKU Costs (custo por SKU, compartilhado entre lojas) ───
router.get('/custos/:sku', async (req, res) => {
  const { rows } = await pool.query(`SELECT cost FROM sku_costs WHERE sku=$1`, [req.params.sku]);
  res.json({ cost: rows[0]?.cost ?? 0 });
});

router.patch('/pedidos/:id/frete-vendedor', async (req, res) => {
  const { cost } = req.body;
  if (cost == null) return res.status(400).json({ error: 'cost required' });
  await pool.query(`UPDATE orders SET shipping_seller_cost=$2 WHERE ml_id=$1`, [req.params.id, Number(cost)]);
  res.json({ ok: true });
});

router.patch('/custos/:sku', async (req, res) => {
  const { cost } = req.body;
  if (cost == null) return res.status(400).json({ error: 'cost required' });
  await pool.query(
    `INSERT INTO sku_costs (sku, cost, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (sku) DO UPDATE SET cost=$2, updated_at=now()`,
    [req.params.sku, Number(cost)]
  );
  // also update items table for existing listings
  await pool.query(`UPDATE items SET cost=$2 WHERE ml_id=$1`, [req.params.sku, Number(cost)]);
  res.json({ ok: true });
});

// ── Detalhes completos de um pedido ───────────────────────
router.get('/pedidos/:id/detalhes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, s.nickname as store_name, s.imposto_pct,
            COALESCE(sc.cost, i.cost, 0) as custo_unitario,
            raw_data
     FROM orders o
     JOIN stores s ON s.id = o.store_id
     LEFT JOIN items i ON i.ml_id = o.item_id
     LEFT JOIN sku_costs sc ON sc.sku = o.item_id
     WHERE o.ml_id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const row = rows[0];
  const fat = Number(row.total_amount) || 0;
  const custo = Number(row.custo_unitario) * (Number(row.quantity) || 1);
  const imposto = fat * (Number(row.imposto_pct) / 100);
  const tarifa = Number(row.ml_fee) || 0;
  const freteComp = Number(row.shipping_cost) || 0;
  const freteVend = Number(row.shipping_seller_cost) || 0;
  const margem = fat - custo - imposto - tarifa - freteComp - freteVend;
  res.json({ ...row, custo, imposto, tarifa, freteComp, freteVend, margem, mc_pct: fat > 0 ? ((margem/fat)*100).toFixed(2) : 0 });
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
  const cfg = await pool.query(`SELECT key, value FROM app_config WHERE key IN ('telegram_bot_token','telegram_chat_id') LIMIT 2`).catch(() => ({ rows: [] }));
  const cfgMap = Object.fromEntries(cfg.rows.map(r => [r.key, r.value]));
  const token = cfgMap.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
  res.json({
    received_today: Number(c.total), processed_today: Number(c.processed),
    failed_today: Number(c.failed), queue_size: Number(c.pending),
    telegram_connected: !!token,
    telegram_chat_id: cfgMap.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '',
    telegram_bot_token_set: !!token,
  });
});

const TG_NOTIF_KEYS = ['tg_vendas','tg_servicos','tg_recursos','tg_reposicao','tg_perguntas','tg_mensagens','tg_promocoes','tg_interval','silence_start','silence_end'];
const ALL_TG_KEYS   = ['telegram_bot_token','telegram_chat_id', ...TG_NOTIF_KEYS];

router.get('/config/telegram', async (req, res) => {
  const { rows } = await pool.query(`SELECT key, value FROM app_config WHERE key = ANY($1)`, [ALL_TG_KEYS]);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const result = {
    bot_token:     map.telegram_bot_token ? '****' + map.telegram_bot_token.slice(-4) : '',
    chat_id:       map.telegram_chat_id || '',
    connected:     !!(map.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN),
  };
  TG_NOTIF_KEYS.forEach(k => { result[k] = map[k] ?? (k.startsWith('tg_') && k !== 'tg_interval' ? 'false' : map[k] || ''); });
  result.tg_interval    = map.tg_interval    || '0';
  result.silence_start  = map.silence_start  || '22:00';
  result.silence_end    = map.silence_end    || '07:00';
  res.json(result);
});

router.patch('/config/telegram', async (req, res) => {
  const { bot_token, chat_id, ...rest } = req.body;
  const upsert = async (key, val) => pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, String(val)]
  );
  if (bot_token && !bot_token.startsWith('****')) await upsert('telegram_bot_token', bot_token);
  if (chat_id != null) await upsert('telegram_chat_id', chat_id);
  for (const k of TG_NOTIF_KEYS) {
    if (rest[k] !== undefined) await upsert(k, rest[k]);
  }
  res.json({ ok: true });
});

router.post('/config/telegram/test', async (req, res) => {
  const { message } = req.body;
  const { rows } = await pool.query(`SELECT key, value FROM app_config WHERE key IN ('telegram_bot_token','telegram_chat_id')`);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const token = map.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = map.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.status(400).json({ error: 'Token ou Chat ID não configurado' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message || 'Teste ML Dashboard ✅' })
    });
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: data.description });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/schedule/jobs', async (req, res) => {
  const { rows } = await pool.query(`SELECT name, cron, last_run, duration_ms, status FROM schedule_jobs`);
  res.json({ jobs: rows });
});

// ── Promoções ──────────────────────────────────────────────
router.get('/promocoes', async (req, res) => {
  const { store_id = '', days = 1 } = req.query;
  const { rows } = await pool.query(
    `SELECT p.id, p.store_id, s.nickname as conta, p.offer_id, p.item_id, p.item_title,
            p.status, p.previous_status, p.original_price, p.promo_price, p.discount_pct, p.changed_at
     FROM promotions p
     JOIN stores s ON s.id = p.store_id
     WHERE ($1 = '' OR p.store_id = $1::bigint)
       AND p.changed_at >= CURRENT_DATE - ($2::int - 1)
     ORDER BY p.changed_at DESC LIMIT 500`,
    [store_id, Number(days)]
  );

  const today = rows.filter(r => new Date(r.changed_at).toDateString() === new Date().toDateString());
  const summary = {
    entrou_hoje:  today.filter(r => r.status === 'active').length,
    saiu_hoje:    today.filter(r => r.status !== 'active' && r.previous_status === 'active').length,
    total_hoje:   today.length,
  };
  res.json({ rows, summary });
});

// ── Monitor: system metrics & security ───────────────────
router.get('/monitor/metrics', async (req, res) => {
  const { execSync } = require('child_process');
  try {
    const cpu = parseFloat(execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'").toString().trim()) || 0;
    const memLine = execSync("free | grep Mem").toString().trim().split(/\s+/);
    const memTotal = Number(memLine[1]);
    const memUsed  = Number(memLine[2]);
    const mem = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    const diskLine = execSync("df / | tail -1").toString().trim().split(/\s+/);
    const disk = parseFloat(diskLine[4]) || 0;
    res.json({ cpu: Number(cpu.toFixed(1)), mem: Number(mem.toFixed(1)), disk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/monitor/security', async (req, res) => {
  const { execSync } = require('child_process');
  try {
    let banned = 0, attempts = 0;
    try {
      const f2b = execSync("fail2ban-client status sshd 2>/dev/null || echo ''").toString();
      const m1 = f2b.match(/Currently banned:\s*(\d+)/);
      const m2 = f2b.match(/Total banned:\s*(\d+)/);
      if (m1) banned = Number(m1[1]);
      if (m2) attempts = Number(m2[1]);
    } catch (_) {}

    let ssh_logins = [];
    try {
      const lastLog = execSync("last -n 20 -F 2>/dev/null | head -20").toString();
      ssh_logins = lastLog.split('\n').filter(l => l && !l.startsWith('wtmp')).slice(0, 10).map(l => {
        const parts = l.trim().split(/\s+/);
        return { user: parts[0] || '?', ip: parts[2] || '?', date: parts.slice(3, 7).join(' '), success: !l.includes('gone') };
      });
    } catch (_) {}

    res.json({ fail2ban: { banned, attempts }, ssh_logins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
