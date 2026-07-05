// REST API — the ONLY interface the frontend is allowed to call.
// Every handler reads from PostgreSQL (optionally cached in Redis).
// None of these handlers call the Mercado Livre API.
const express = require('express');
const { spawn } = require('child_process');
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
  const { status = '', search = '', store_id = '', days = '' } = req.query;
  const dateFilter = days ? `AND updated_at >= now() - interval '${Number(days)} days'` : '';
  const { rows } = await pool.query(
    `SELECT ml_id, store_id, title, price, available_quantity, sold_quantity, status, updated_at
     FROM items
     WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR title ILIKE '%'||$2||'%')
       AND ($3 = '' OR store_id = $3::bigint)
       ${dateFilter}
     ORDER BY updated_at DESC LIMIT 500`,
    [status, search, store_id]
  );
  const summary = await pool.query(
    `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='active') active,
            COUNT(*) FILTER (WHERE status='paused') paused,
            COUNT(*) FILTER (WHERE status='closed') closed
     FROM items WHERE ($1 = '' OR store_id = $1::bigint) ${dateFilter}`,
    [store_id]
  );
  res.json({ results: rows, summary: summary.rows[0] });
});

router.get('/produtos', async (req, res) => {
  const { search = '', sortBy = 'vendas', days = '', store_id = '' } = req.query;
  const dateFilter  = days     ? `AND i.updated_at >= now() - interval '${Number(days)} days'` : '';
  const storeFilter = store_id ? `AND i.store_id = ${BigInt(store_id)}` : '';
  const orderBy = sortBy === 'receita' ? 'sold_quantity * price DESC' : sortBy === 'estoque' ? 'available_quantity ASC' : 'sold_quantity DESC';
  const { rows } = await pool.query(
    `SELECT i.ml_id as id, i.title, i.price,
            i.available_quantity as stock, i.sold_quantity as sold,
            i.sold_quantity * i.price as revenue, i.status
     FROM items i
     WHERE ($1 = '' OR i.title ILIKE '%'||$1||'%')
       ${storeFilter} ${dateFilter}
     ORDER BY ${orderBy} LIMIT 500`,
    [search]
  );
  res.json({ products: rows });
});

// ── Pedidos / Vendas ───────────────────────────────────────
router.get('/pedidos', async (req, res) => {
  const { status = '', period = '7' } = req.query;
  let dateFilter;
  if (period === 'hoje')  dateFilter = `AND o.date_created::date = CURRENT_DATE`;
  else if (period === 'ontem') dateFilter = `AND o.date_created::date = CURRENT_DATE - 1`;
  else dateFilter = `AND o.date_created >= CURRENT_DATE - ${Number(period)}`;

  const statusFilter = status ? `AND o.status = '${status.replace(/'/g,"''")}'` : '';

  const [{ rows }, kpi] = await Promise.all([
    pool.query(
      `SELECT o.ml_id as id, o.buyer_nickname, o.title, o.total_amount, o.status, o.date_created,
              COALESCE(s.nickname, 'Loja '||o.store_id::text) as loja
       FROM orders o LEFT JOIN stores s ON s.id = o.store_id
       WHERE 1=1 ${dateFilter} ${statusFilter}
       ORDER BY o.date_created DESC LIMIT 500`
    ),
    pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(total_amount) FILTER (WHERE status != 'cancelled') as receita,
         COUNT(*) FILTER (WHERE status = 'paid') as paid,
         COUNT(*) FILTER (WHERE status = 'ready_to_ship') as ready_to_ship,
         COUNT(*) FILTER (WHERE status = 'shipped') as shipped,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
       FROM orders o WHERE 1=1 ${dateFilter}`
    )
  ]);
  res.json({ results: rows, summary: kpi.rows[0] });
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
  try {
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
  } catch (e) {
    console.error('[api] /vendas/detalhado error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Vendas Hoje ────────────────────────────────────────────
router.get('/vendas/hoje', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.total_amount, o.ml_fee, o.shipping_cost, COALESCE(o.shipping_seller_cost,0) AS shipping_seller_cost,
              o.quantity, COALESCE(i.cost,0) AS custo, COALESCE(s.imposto_pct,0) AS imposto_pct
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       LEFT JOIN items i ON i.ml_id = o.item_id
       WHERE o.date_created::date = CURRENT_DATE AND o.status != 'cancelled'`
    );
    const pedidos   = rows.length;
    const itens     = rows.reduce((a,r) => a + (Number(r.quantity)||1), 0);
    const receita   = rows.reduce((a,r) => a + Number(r.total_amount), 0);
    const lucro     = rows.reduce((a,r) => {
      const fat   = Number(r.total_amount);
      const custo = Number(r.custo) * (Number(r.quantity)||1);
      const imp   = fat * (Number(r.imposto_pct)/100);
      const tar   = Number(r.ml_fee)||0;
      const fc    = Number(r.shipping_cost)||0;
      const fv    = Number(r.shipping_seller_cost)||0;
      return a + (fat - custo - imp - tar - fc - fv);
    }, 0);
    const mc_pct = receita > 0 ? (lucro / receita) * 100 : 0;
    res.json({ pedidos, itens, receita, lucro, mc_pct: Number(mc_pct.toFixed(2)) });
  } catch (e) {
    console.error('[api] /vendas/hoje error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Configuração de loja (imposto, etc.) ───────────────────
router.patch('/lojas/:id', async (req, res) => {
  const { imposto_pct } = req.body;
  if (imposto_pct == null) return res.status(400).json({ error: 'imposto_pct required' });
  await pool.query(`UPDATE stores SET imposto_pct=$2 WHERE id=$1`, [req.params.id, Number(imposto_pct)]);
  res.json({ ok: true });
});

router.patch('/lojas/:id/credentials', async (req, res) => {
  const { ml_client_id, ml_client_secret } = req.body;
  if (!ml_client_id || !ml_client_secret) return res.status(400).json({ error: 'ml_client_id and ml_client_secret required' });
  await pool.query(
    `UPDATE stores SET ml_client_id=$2, ml_client_secret=$3 WHERE id=$1`,
    [req.params.id, ml_client_id.trim(), ml_client_secret.trim()]
  );
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
  try {
    const { rows } = await pool.query(
      `SELECT o.ml_id, o.store_id, o.buyer_nickname, o.item_id, o.title,
              o.total_amount, o.quantity, o.unit_price, o.ml_fee,
              o.shipping_type, o.shipping_cost, o.shipping_seller_cost,
              o.status, o.date_created, o.date_closed,
              o.raw_data,
              s.nickname as store_name, s.imposto_pct,
              COALESCE(i.cost, 0) as custo_unitario
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       LEFT JOIN items i ON i.ml_id = o.item_id
       WHERE o.ml_id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: `Pedido ${req.params.id} não encontrado` });
    const row = rows[0];
    const fat = Number(row.total_amount) || 0;
    const custo = Number(row.custo_unitario) * (Number(row.quantity) || 1);
    const imposto = fat * (Number(row.imposto_pct) / 100);
    const tarifa = Number(row.ml_fee) || 0;
    const freteComp = Number(row.shipping_cost) || 0;
    const freteVend = Number(row.shipping_seller_cost) || 0;
    const margem = fat - custo - imposto - tarifa - freteComp - freteVend;
    res.json({ ...row, custo, imposto, tarifa, freteComp, freteVend, margem, mc_pct: fat > 0 ? ((margem/fat)*100).toFixed(2) : 0 });
  } catch(e) {
    console.error('[/pedidos/:id/detalhes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Perguntas / Mensagens ──────────────────────────────────
router.get('/perguntas', async (req, res) => {
  const { status = 'UNANSWERED', store_id = '' } = req.query;
  const [{ rows }, kpi] = await Promise.all([
    pool.query(
      `SELECT q.ml_id as id, q.store_id, COALESCE(s.nickname,'Loja '||q.store_id::text) as loja,
              q.item_id, q.item_title, q.text, q.answer_text, q.status, q.date_created
       FROM questions q
       LEFT JOIN stores s ON s.id = q.store_id
       WHERE ($1 = '' OR q.status = $1)
         AND ($2 = '' OR q.store_id = $2::bigint)
       ORDER BY q.date_created DESC LIMIT 200`,
      [status, store_id]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='UNANSWERED') as unanswered,
         COUNT(*) FILTER (WHERE status='ANSWERED' AND updated_at::date = CURRENT_DATE) as answered_today,
         COUNT(*) as total,
         ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - date_created))/3600) FILTER (WHERE status='ANSWERED'), 1) as avg_hours
       FROM questions`
    )
  ]);
  const k = kpi.rows[0];
  res.json({
    questions: rows,
    summary: {
      unanswered:     Number(k.unanswered),
      answered_today: Number(k.answered_today),
      total:          Number(k.total),
      avg_response_time: k.avg_hours ? Number(k.avg_hours) : null,
    }
  });
});

router.post('/perguntas/:id/responder', express.json(), async (req, res) => {
  try {
    const { text } = req.body;
    const questionId = req.params.id;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });

    // Find which store owns this question to use the correct token
    const { rows } = await pool.query(`SELECT store_id FROM questions WHERE ml_id=$1 LIMIT 1`, [questionId]);
    if (!rows.length) return res.status(404).json({ error: 'question not found' });
    const storeId = rows[0].store_id;

    // Call ML API to post the answer
    const ml = require('../mlClient');
    await ml.answerQuestion(questionId, text, storeId);

    // Update local DB
    await pool.query(
      `UPDATE questions SET answer_text=$2, status='ANSWERED', updated_at=now() WHERE ml_id=$1`,
      [questionId, text]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[api] responder pergunta', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/mensagens', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.pack_id, m.buyer_nickname, m.last_message, m.unread, m.last_message_date, s.nickname as loja
     FROM messages m LEFT JOIN stores s ON s.id = m.store_id
     ORDER BY m.last_message_date DESC LIMIT 50`
  );
  res.json({ conversations: rows, summary: {} });
});

// ── Estoque Parado ─────────────────────────────────────────
router.get('/analises/estoque-parado', async (req, res) => {
  try {
    const { store_id = '', days = '30', modo = 'parado' } = req.query;
    const storeFilter = store_id ? `AND i.store_id = ${BigInt(store_id)}` : '';
    const daysN = Number(days) || 30;

    // Vendas por item no período + última venda histórica
    const { rows: salesRows } = await pool.query(
      `SELECT
         COALESCE(item_id, raw_data->'order_items'->0->'item'->>'id') as iid,
         store_id,
         SUM(CASE WHEN date_created >= CURRENT_DATE - ${daysN} THEN quantity ELSE 0 END) as qtd_periodo,
         MAX(date_created) as ultimo_dia_venda
       FROM orders
       WHERE status != 'cancelled'
       GROUP BY 1, 2`
    );
    const salesMap = {};
    salesRows.forEach(r => {
      if (r.iid) salesMap[`${r.store_id}:${r.iid}`] = { qtd: Number(r.qtd_periodo), ultima: r.ultimo_dia_venda };
    });

    const { rows: itemRows } = await pool.query(
      `SELECT i.ml_id, i.store_id,
              COALESCE(s.nickname, 'Loja '||i.store_id::text) as loja,
              i.title, i.price, i.available_quantity as estoque,
              i.sold_quantity, i.thumbnail, i.permalink
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
       WHERE i.status = 'active'
         AND i.available_quantity > 0
         ${storeFilter}
       LIMIT 2000`
    );

    // Anexa vendas do período
    let rows = itemRows.map(i => {
      const sale = salesMap[`${i.store_id}:${i.ml_id}`] || { qtd: 0, ultima: null };
      return { ...i, vendas_periodo: sale.qtd, ultimo_dia_venda: sale.ultima };
    });

    if (modo === 'parado') {
      // Só quem não vendeu nada no período
      rows = rows.filter(i => i.vendas_periodo === 0);
    }

    // Ordena: menos vendido primeiro, desempate por maior capital
    rows.sort((a, b) => a.vendas_periodo - b.vendas_periodo || (b.price * b.estoque) - (a.price * a.estoque));
    rows = rows.slice(0, 500);

    res.json({ items: rows, total: rows.length, days: daysN });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Alertas ────────────────────────────────────────────────
router.get('/alertas/reposicao', async (req, res) => {
  try {
    const threshold = Number(req.query.threshold) || 15;
    const store_id  = req.query.store_id || '';
    const params = [threshold];
    const storeFilter = store_id
      ? `AND i.store_id = ${BigInt(store_id)}`
      : '';
    const { rows } = await pool.query(
      `SELECT i.ml_id, i.store_id,
              COALESCE(s.nickname, 'Loja ' || i.store_id::text, 'Sem loja') as loja,
              i.title, i.price,
              i.available_quantity as stock, i.sold_quantity,
              COALESCE(i.sold_quantity::float / 30, 0) as daily_sales,
              i.thumbnail, i.permalink, i.updated_at
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
       WHERE i.status = 'active'
         AND i.available_quantity <= $1
         ${storeFilter}
       ORDER BY i.available_quantity ASC, i.sold_quantity DESC`,
      params
    );
    const summary = {
      zero:     rows.filter(r => r.stock === 0).length,
      critical: rows.filter(r => r.stock > 0 && r.stock <= 3).length,
      low:      rows.filter(r => r.stock > 3 && r.stock <= 10).length,
      medium:   rows.filter(r => r.stock > 10).length,
      total:    rows.length,
    };
    res.json({ items: rows, summary });
  } catch(e) {
    console.error('[reposicao]', e.message);
    res.status(500).json({ error: e.message, items: [], summary: {} });
  }
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
            imposto_pct, token_expires_at, updated_at,
            ml_client_id,
            CASE WHEN ml_client_id IS NOT NULL THEN true ELSE false END as has_own_credentials,
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

const TG_NOTIF_KEYS = ['tg_vendas','tg_servicos','tg_recursos','tg_reposicao','tg_perguntas','tg_mensagens','tg_promocoes','tg_devolucoes','tg_anuncios','tg_token','tg_fila','tg_429','tg_infra','tg_interval','silence_start','silence_end'];
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
  try {
    const { rows } = await pool.query(`SELECT name, cron, last_run, duration_ms, status FROM schedule_jobs`);
    res.json({ jobs: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule/jobs/:name/trigger', async (req, res) => {
  const { name } = req.params;
  if (!['dailySync','syncReturns','syncParentItems','syncVisitas'].includes(name)) return res.status(400).json({ error: 'job desconhecido' });
  await redis.publish('worker:cmd', JSON.stringify({ cmd: name }));
  res.json({ ok: true, message: 'comando enviado ao worker' });
});

// Stream journalctl em tempo real via SSE
router.get('/schedule/worker-logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // desativa buffer do nginx
  res.flushHeaders();

  // Envia últimas 80 linhas + segue em tempo real
  const proc = spawn('journalctl', ['-u', 'ml-worker-novo', '-f', '-n', '80', '--no-pager', '--output=cat']);

  const send = (line) => {
    const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim(); // remove cores ANSI
    if (clean) res.write(`data: ${JSON.stringify(clean)}\n\n`);
  };

  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(send);
  });
  proc.stderr.on('data', chunk => send(chunk.toString()));

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    proc.kill();
  });
});

router.get('/schedule/runs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const job   = req.query.job || '';
    const { rows } = await pool.query(
      `SELECT id, job_name, started_at, finished_at, duration_ms, status, report, error_msg
       FROM schedule_runs
       WHERE ($1 = '' OR job_name = $1)
       ORDER BY started_at DESC
       LIMIT $2`,
      [job, limit]
    );
    res.json({ runs: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/schedule/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, topic, resource, store_id, status, error, received_at, processed_at
       FROM webhook_logs
       ORDER BY received_at DESC
       LIMIT $1`, [limit]
    );
    res.json({ logs: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Promoções ──────────────────────────────────────────────
router.get('/promocoes', async (req, res) => {
  try {
    const { store_id = '', days = 1 } = req.query;
    const { rows } = await pool.query(
      `SELECT p.id, p.store_id,
              COALESCE(s.nickname, 'Loja '||p.store_id::text) as conta,
              p.offer_id, p.item_id, p.item_title,
              p.status, p.previous_status,
              COALESCE(NULLIF(p.original_price,0), i.price, 0) as original_price,
              COALESCE(NULLIF(p.promo_price,0), i.price, 0) as promo_price,
              p.discount_pct, p.changed_at, p.raw_data
       FROM promotions p
       LEFT JOIN stores s ON s.id = p.store_id
       LEFT JOIN items i ON i.ml_id = p.item_id
       WHERE ($1 = '' OR p.store_id = $1::bigint)
         AND p.changed_at >= CURRENT_DATE - ($2::int - 1)
       ORDER BY p.changed_at DESC LIMIT 500`,
      [store_id, Number(days)]
    );
    const today = rows.filter(r => new Date(r.changed_at).toDateString() === new Date().toDateString());
    const summary = {
      entrou_hoje: today.filter(r => r.status === 'active' && !r.previous_status).length,
      saiu_hoje:   today.filter(r => r.status !== 'active' && r.previous_status === 'active').length,
      total_hoje:  today.length,
    };
    res.json({ rows, summary });
  } catch(e) {
    console.error('[api] /promocoes', e.message);
    res.status(500).json({ error: e.message, rows: [], summary: {} });
  }
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

// ── Dashboard chart & top products ────────────────────────
router.get('/dashboard/chart', async (req, res) => {
  const period = Number(req.query.period) || 7;
  const { rows } = await pool.query(
    `SELECT date_created::date as data,
            COUNT(*) pedidos,
            COALESCE(SUM(total_amount),0) receita
     FROM orders
     WHERE date_created >= CURRENT_DATE - $1::int AND status != 'cancelled'
     GROUP BY 1 ORDER BY 1`,
    [period]
  );
  res.json({ rows });
});

router.get('/dashboard/top-products', async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const { rows } = await pool.query(
    `SELECT item_id, title,
            COUNT(*) pedidos,
            SUM(quantity) unidades,
            SUM(total_amount) receita
     FROM orders
     WHERE status != 'cancelled' AND item_id IS NOT NULL
     GROUP BY item_id, title
     ORDER BY receita DESC LIMIT $1`,
    [limit]
  );
  res.json({ products: rows });
});

// ── Análises temporais ─────────────────────────────────────
router.get('/analises/horarios', async (req, res) => {
  try {
    const { store_id = '', period = '7' } = req.query;
    const storeFilter = store_id ? `AND store_id = ${BigInt(store_id)}` : '';
    let dateFilter;
    if (period === 'hoje')        dateFilter = `AND date_created::date = CURRENT_DATE`;
    else if (period === 'ontem')  dateFilter = `AND date_created::date = CURRENT_DATE - 1`;
    else                          dateFilter = `AND date_created >= CURRENT_DATE - ${Number(period)}`;
    const { rows } = await pool.query(
      `SELECT EXTRACT(hour FROM date_created AT TIME ZONE 'America/Sao_Paulo')::int as hora,
              COUNT(*) pedidos,
              COALESCE(SUM(total_amount),0) receita
       FROM orders
       WHERE status != 'cancelled'
         ${dateFilter}
         ${storeFilter}
       GROUP BY 1 ORDER BY 1`
    );
    res.json({ hours: rows.map(r => ({ hour: r.hora, orders: Number(r.pedidos), revenue: Number(r.receita) })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/analises/dias-semana', async (req, res) => {
  const { store_id = '', days = 90 } = req.query;
  const diasNome = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const { rows } = await pool.query(
    `SELECT EXTRACT(dow FROM date_created AT TIME ZONE 'America/Sao_Paulo')::int as dow,
            COUNT(*) pedidos,
            COALESCE(SUM(total_amount),0) receita
     FROM orders
     WHERE status != 'cancelled'
       AND date_created >= CURRENT_DATE - $1::int
       AND ($2 = '' OR store_id = $2::bigint)
     GROUP BY 1 ORDER BY 1`,
    [Number(days), store_id]
  );
  res.json({ days: rows.map(r => ({ day: r.dow, dia: diasNome[r.dow], orders: Number(r.pedidos), revenue: Number(r.receita) })) });
});

// ── Comparativos ───────────────────────────────────────────
router.get('/comparativos/periodos', async (req, res) => {
  const { p1 = '30', p2 = '30' } = req.query;
  const [from1, to1] = p1.includes('|') ? p1.split('|') : [null, null];
  const [from2, to2] = p2.includes('|') ? p2.split('|') : [null, null];
  const buildClause = (from, to, days) => from && to
    ? [`date_created >= '${from}'::date AND date_created <= '${to}'::date + INTERVAL '1 day'`, []]
    : [`date_created >= CURRENT_DATE - $1::int AND date_created < CURRENT_DATE`, [Number(days)]];
  const [clause1, args1] = buildClause(from1, to1, p1);
  const [clause2, args2] = buildClause(from2, to2, p2);
  const [r1, r2] = await Promise.all([
    pool.query(`SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
                       CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END avg_ticket,
                       SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelamentos
                FROM orders WHERE ${clause1}`, args1),
    pool.query(`SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
                       CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END avg_ticket,
                       SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelamentos
                FROM orders WHERE ${clause2}`, args2),
  ]);
  const map = r => ({ orders: Number(r.pedidos), revenue: Number(r.receita), avg_ticket: Number(r.avg_ticket), cancellations: Number(r.cancelamentos) });
  res.json({ p1: map(r1.rows[0]), p2: map(r2.rows[0]), chart: [] });
});

router.get('/comparativos/evolucao', async (req, res) => {
  const { days = 30, store_id = '' } = req.query;
  const { rows } = await pool.query(
    `SELECT date_created::date as date,
            SUM(total_amount) as revenue,
            COUNT(*) as orders
     FROM orders
     WHERE status!='cancelled'
       AND date_created >= CURRENT_DATE - $1::int
       AND ($2 = '' OR store_id = $2::bigint)
     GROUP BY date_created::date ORDER BY 1`,
    [Number(days), store_id]
  );
  res.json({ rows: rows.map(r => ({ date: r.date, revenue: Number(r.revenue), orders: Number(r.orders) })) });
});

router.get('/comparativos/curva-abc', async (req, res) => {
  try {
    const { store_id = '', period = '30' } = req.query;
    const storeFilter = store_id ? `AND o.store_id = ${BigInt(store_id)}` : '';

    let dateFilter;
    if (period === 'hoje') dateFilter = `AND o.date_created::date = CURRENT_DATE`;
    else if (period === 'ontem') dateFilter = `AND o.date_created::date = CURRENT_DATE - 1`;
    else dateFilter = `AND o.date_created >= CURRENT_DATE - ${Number(period)}`;

    const { rows } = await pool.query(`
      SELECT
        iid                                                 AS item_id,
        COALESCE(MAX(o.title), MAX(i.title))                AS title,
        MAX(s.nickname)                                     AS loja,
        COUNT(*)                                            AS pedidos,
        SUM(COALESCE(o.total_amount, 0))                    AS faturamento
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      -- resolve item_id uma vez (CTE-inline)
      CROSS JOIN LATERAL (
        SELECT COALESCE(o.item_id, o.raw_data->'order_items'->0->'item'->>'id') AS iid
      ) ids
      -- busca título no catálogo quando orders.title é NULL
      LEFT JOIN items i ON i.ml_id = ids.iid AND i.store_id = o.store_id
      WHERE o.status != 'cancelled'
        ${dateFilter}
        ${storeFilter}
      GROUP BY ids.iid, s.nickname
      HAVING SUM(COALESCE(o.total_amount, 0)) > 0
      ORDER BY faturamento DESC
    `);

    const total = rows.reduce((a, r) => a + Number(r.faturamento), 0);
    let acum = 0;
    const items = rows.map(r => {
      acum += Number(r.faturamento);
      const pct = total > 0 ? (acum / total) * 100 : 0;
      const curva = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
      return {
        item_id: r.item_id,
        title: r.title,
        loja: r.loja,
        pedidos: Number(r.pedidos),
        faturamento: Number(r.faturamento),
        pct_acum: Number(pct.toFixed(1)),
        pct_item: total > 0 ? Number((Number(r.faturamento)/total*100).toFixed(1)) : 0,
        curva,
      };
    });

    const summary = {
      A: { count: 0, faturamento: 0 },
      B: { count: 0, faturamento: 0 },
      C: { count: 0, faturamento: 0 },
    };
    items.forEach(i => { summary[i.curva].count++; summary[i.curva].faturamento += i.faturamento; });

    res.json({ items, summary, total });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clientes ───────────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  const { store_id = '', search = '', days = 365 } = req.query;
  const { rows } = await pool.query(
    `SELECT buyer_nickname as nickname,
            COUNT(*) total_orders,
            SUM(total_amount) total_spent,
            AVG(total_amount) avg_ticket,
            MAX(date_created) last_order_date,
            MIN(date_created) first_order_date
     FROM orders
     WHERE status != 'cancelled'
       AND ($1 = '' OR store_id = $1::bigint)
       AND date_created >= CURRENT_DATE - $2::int
       AND ($3 = '' OR LOWER(buyer_nickname) LIKE LOWER('%'||$3||'%'))
     GROUP BY buyer_nickname
     ORDER BY total_spent DESC LIMIT 200`,
    [store_id, Number(days), search]
  );
  const mesInicio = new Date(); mesInicio.setDate(1); mesInicio.setHours(0,0,0,0);
  const clients = rows.map(r => ({ ...r, total_orders: Number(r.total_orders), total_spent: Number(r.total_spent), avg_ticket: Number(r.avg_ticket) }));
  const summary = {
    total: clients.length,
    new_this_month: clients.filter(r => new Date(r.first_order_date) >= mesInicio).length,
    returning: clients.filter(r => Number(r.total_orders) > 1).length,
    avg_ticket: clients.length ? clients.reduce((s,r)=>s+r.avg_ticket,0)/clients.length : 0,
  };
  res.json({ clients, summary });
});

router.get('/clientes/:nickname', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ml_id, item_id, title, total_amount, status, date_created, store_id
     FROM orders WHERE buyer_nickname = $1 ORDER BY date_created DESC LIMIT 100`,
    [req.params.nickname]
  );
  res.json({ pedidos: rows });
});

// ── Alertas faltando ───────────────────────────────────────
router.get('/alertas/devolucoes', async (req, res) => {
  const { store_id = '', q = '' } = req.query;
  const searchFilter = q ? `AND (r.order_id::text ILIKE $2 OR r.buyer_nickname ILIKE $2 OR r.title ILIKE $2)` : '';
  const params = [store_id];
  if (q) params.push(`%${q}%`);
  const { rows } = await pool.query(
    `SELECT r.id, r.store_id, s.nickname as conta, r.order_id,
            r.buyer_nickname, r.title, r.reason, r.amount, r.status, r.date, r.note
     FROM returns r
     LEFT JOIN stores s ON s.id = r.store_id
     WHERE ($1 = '' OR r.store_id = $1::bigint) ${searchFilter}
     ORDER BY r.date DESC LIMIT 200`,
    params
  );
  const summary = {
    in_analysis: rows.filter(r => r.status === 'analysis' || r.status === 'opened').length,
    approved:    rows.filter(r => r.status === 'approved' || r.status === 'resolved').length,
    rejected:    rows.filter(r => r.status === 'rejected' || r.status === 'closed').length,
    total_value: rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0),
    total:       rows.length,
  };
  res.json({ items: rows, summary });
});

router.patch('/alertas/devolucoes/:id/note', async (req, res) => {
  const { note } = req.body;
  const { rows } = await pool.query(
    `UPDATE returns SET note = $1, updated_at = now() WHERE id = $2 RETURNING id, note`,
    [note, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

router.get('/alteracoes', async (req, res) => {
  try {
    const { store_id = '', days = 7, limit = 200 } = req.query;
    const storeFilter = store_id ? `AND ic.store_id = ${BigInt(store_id)}` : '';
    const { rows } = await pool.query(
      `SELECT ic.id, ic.item_id, ic.store_id, ic.changes, ic.changed_at,
              COALESCE(i.title, ic.item_id) as title,
              i.thumbnail, i.permalink,
              COALESCE(s.nickname, 'Loja '||ic.store_id::text) as loja
       FROM item_changes ic
       LEFT JOIN items i ON i.ml_id = ic.item_id
       LEFT JOIN stores s ON s.id = ic.store_id
       WHERE ic.changed_at >= now() - ($1::int * interval '1 day')
         ${storeFilter}
       ORDER BY ic.changed_at DESC
       LIMIT $2`,
      [Number(days), Number(limit)]
    );
    res.json({ changes: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/alertas/anuncios-problema', async (req, res) => {
  const { store_id = '' } = req.query;
  const { rows } = await pool.query(
    `SELECT i.ml_id, i.store_id, i.title, i.price, i.available_quantity,
            i.sold_quantity, i.status, i.updated_at,
            COALESCE(o.pedidos_30d, 0) as pedidos_30d
     FROM items i
     LEFT JOIN (
       SELECT item_id, COUNT(*) pedidos_30d FROM orders
       WHERE status != 'cancelled' AND date_created >= CURRENT_DATE - 30
       GROUP BY item_id
     ) o ON o.item_id = i.ml_id
     WHERE ($1 = '' OR i.store_id = $1::bigint)
       AND i.status IN ('active','paused','closed','under_review')
     ORDER BY i.updated_at DESC LIMIT 200`,
    [store_id]
  );
  const items = rows.map(r => {
    let problem_type = null, severity = 'medium', suggestion = null;
    if (r.status !== 'active') {
      problem_type = 'low_reputation';
      severity = r.status === 'closed' ? 'high' : 'medium';
      suggestion = r.status === 'paused' ? 'Reativar anúncio' : 'Verificar restrições do anúncio';
    } else if (r.available_quantity === 0) {
      problem_type = 'no_sales';
      severity = 'high';
      suggestion = 'Repor estoque urgente';
    } else if (r.pedidos_30d === 0 && r.available_quantity > 0) {
      problem_type = 'no_sales';
      severity = 'medium';
      suggestion = 'Revisar preço e fotos';
    }
    return { ...r, problem_type, severity, suggestion };
  }).filter(r => r.problem_type);
  const summary = {
    no_sales:       items.filter(r => r.problem_type === 'no_sales').length,
    low_reputation: items.filter(r => r.problem_type === 'low_reputation').length,
    missing_info:   0,
    price:          0,
  };
  res.json({ items, summary });
});

// ── Métricas do vendedor (reputação) ──────────────────────
router.get('/metricas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (store_id)
              sm.store_id, s.nickname, sm.level_id, sm.power_seller_status,
              sm.transactions_completed, sm.positive_ratings_pct,
              sm.negative_ratings_pct, sm.neutral_ratings_pct, sm.collected_at
       FROM store_metrics sm
       JOIN stores s ON s.id = sm.store_id
       ORDER BY store_id, collected_at DESC`
    );
    res.json({ metricas: rows });
  } catch(e) {
    console.error('[/metricas]', e.message);
    res.status(500).json({ error: e.message, metricas: [] });
  }
});

// ── Produtos performance ───────────────────────────────────
router.get('/produtos/performance', async (req, res) => {
  try {
    const { store_id = '', days = 30, sort = 'receita' } = req.query;
    const orderBy = {
      receita:    'receita_periodo DESC NULLS LAST',
      vendas:     'pedidos_periodo DESC NULLS LAST',
      visitas:    'visitas_periodo DESC NULLS LAST',
      conversao:  'conversao_pct DESC NULLS LAST',
    }[sort] || 'receita_periodo DESC NULLS LAST';

    const { rows } = await pool.query(
      `WITH order_agg AS (
         SELECT COALESCE(it.parent_item_id, o.item_id) AS root_id,
                COUNT(*)            AS pedidos,
                SUM(o.total_amount) AS receita
         FROM orders o
         LEFT JOIN items it ON it.ml_id = o.item_id
         WHERE o.status != 'cancelled'
           AND o.date_created >= CURRENT_DATE - $1::int
           AND ($2 = '' OR o.store_id = $2::bigint)
         GROUP BY 1
       ),
       visit_agg AS (
         SELECT COALESCE(it.parent_item_id, iv.item_id) AS root_id,
                SUM(iv.visits) AS visitas
         FROM item_visits iv
         LEFT JOIN items it ON it.ml_id = iv.item_id
         WHERE iv.date >= CURRENT_DATE - $1::int
           AND ($2 = '' OR iv.store_id = $2::bigint)
         GROUP BY 1
       ),
       item_repr AS (
         SELECT DISTINCT ON (COALESCE(parent_item_id, ml_id))
           ml_id, title, price, available_quantity, sold_quantity, status,
           thumbnail, permalink,
           COALESCE(parent_item_id, ml_id) AS group_key
         FROM items
         WHERE ($2 = '' OR store_id = $2::bigint)
         ORDER BY COALESCE(parent_item_id, ml_id), parent_item_id NULLS FIRST
       )
       SELECT r.ml_id, r.title, r.price, r.available_quantity, r.sold_quantity, r.status,
              r.thumbnail, r.permalink,
              COALESCE(o.pedidos, 0) AS pedidos_periodo,
              COALESCE(o.receita, 0) AS receita_periodo,
              COALESCE(v.visitas, 0) AS visitas_periodo,
              CASE WHEN COALESCE(v.visitas, 0) > 0
                   THEN ROUND(COALESCE(o.pedidos,0)::numeric / v.visitas * 100, 2)
                   ELSE 0 END AS conversao_pct
       FROM item_repr r
       LEFT JOIN order_agg o ON o.root_id = r.group_key
       LEFT JOIN visit_agg v ON v.root_id = r.group_key
       ORDER BY ${orderBy}
       LIMIT 200`,
      [Number(days), store_id]
    );
    res.json({ products: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/vendas/por-loja', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const { rows: current } = await pool.query(`
      SELECT
        o.store_id,
        s.nickname as loja,
        (o.date_created - INTERVAL '3 hours')::date AS dia,
        COUNT(*) as pedidos,
        SUM(o.total_amount) as receita
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      WHERE o.date_created >= CURRENT_DATE - ($1::int)
        AND o.status != 'cancelled'
      GROUP BY 1, 2, 3
      ORDER BY 3, 2
    `, [days]);

    const { rows: previous } = await pool.query(`
      SELECT
        o.store_id,
        (o.date_created - INTERVAL '3 hours')::date AS dia,
        SUM(o.total_amount) as receita
      FROM orders o
      WHERE o.date_created >= CURRENT_DATE - ($1::int)
        AND o.date_created < CURRENT_DATE - 30
        AND o.status != 'cancelled'
      GROUP BY 1, 2
    `, [days + 30]);

    res.json({ current, previous });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/anuncios/:id/visitas', async (req, res) => {
  const { days = 30 } = req.query;
  const { rows } = await pool.query(
    `SELECT date, visits FROM item_visits
     WHERE item_id = $1 AND date >= CURRENT_DATE - $2::int
     ORDER BY date ASC`,
    [req.params.id, Number(days)]
  );
  res.json({ visitas: rows });
});

// Histórico diário de visitas + vendas por item (usado no modal de performance)
router.get('/produtos/:id/historico-diario', async (req, res) => {
  try {
    const { id } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const storeFilter = req.query.store_id ? `AND o.store_id = ${BigInt(req.query.store_id)}` : '';

    // Descobre o root_id (parent_item_id ou o próprio id)
    const { rows: itemRow } = await pool.query(
      `SELECT COALESCE(parent_item_id, ml_id) AS root_id, store_id FROM items WHERE ml_id = $1 LIMIT 1`, [id]
    );
    const rootId  = itemRow[0]?.root_id  || id;
    const storeId = itemRow[0]?.store_id || null;

    // Visitas por dia para o item (e suas variações)
    const { rows: visitas } = await pool.query(
      `SELECT iv.date, SUM(iv.visits) AS visitas
       FROM item_visits iv
       LEFT JOIN items it ON it.ml_id = iv.item_id
       WHERE COALESCE(it.parent_item_id, iv.item_id) = $1
         AND iv.date >= CURRENT_DATE - $2::int
       GROUP BY iv.date
       ORDER BY iv.date DESC`,
      [rootId, days]
    );

    // Vendas por dia para o item (e suas variações)
    const { rows: vendas } = await pool.query(
      `SELECT (o.date_created - INTERVAL '3 hours')::date AS dia,
              COUNT(*) AS pedidos,
              SUM(o.total_amount) AS receita
       FROM orders o
       LEFT JOIN items it ON it.ml_id = o.item_id
       WHERE COALESCE(it.parent_item_id, o.item_id) = $1
         AND o.status != 'cancelled'
         AND o.date_created >= CURRENT_DATE - $2::int
         ${storeFilter}
       GROUP BY 1
       ORDER BY 1 DESC`,
      [rootId, days]
    );

    // Merge por data
    const map = {};
    const toISO = v => (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);
    for (const v of visitas) {
      const d = toISO(v.date);
      map[d] = { data: d, visitas: Number(v.visitas), pedidos: 0, receita: 0 };
    }
    for (const v of vendas) {
      const d = toISO(v.dia);
      if (!map[d]) map[d] = { data: d, visitas: 0, pedidos: 0, receita: 0 };
      map[d].pedidos = Number(v.pedidos);
      map[d].receita = Number(v.receita);
    }

    const rows = Object.values(map)
      .sort((a, b) => b.data.localeCompare(a.data))
      .map(r => ({
        ...r,
        conversao_pct: r.visitas > 0 ? ((r.pedidos / r.visitas) * 100).toFixed(1) : null,
      }));

    res.json({ rows, item_id: id, root_id: rootId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
