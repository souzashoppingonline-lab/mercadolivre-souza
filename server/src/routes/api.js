// REST API — the ONLY interface the frontend is allowed to call.
// Every handler reads from PostgreSQL (optionally cached in Redis).
// None of these handlers call the Mercado Livre API.
const express = require('express');
const { spawn } = require('child_process');
const pool = require('../db/pool');
const redis = require('../db/redis');
const { getResumoDiarioData, getTopVendas, getResumoSemanal, getOutliersOntem, getEstoqueCriticoTopVendas } = require('../reports');

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
       FROM vw_ml_orders WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND status != 'cancelled'`
    );
    const perguntas = await pool.query(`SELECT COUNT(*) n FROM questions WHERE status='UNANSWERED'`);
    const anuncios = await pool.query(`SELECT COUNT(*) n FROM vw_ml_items WHERE status='active'`);
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
    `SELECT title, available_quantity FROM vw_ml_items WHERE status='active' AND available_quantity <= 5 ORDER BY available_quantity ASC LIMIT 10`
  );
  res.json(rows);
});

// ── Top Vendas Online (página "morning digest") ─────────────
// Reaproveita reports.js — mesmas queries usadas pelo worker para os
// relatórios de Telegram/e-mail, nunca duplicadas aqui. Ver .claude/workers.md.
router.get('/dashboard/resumo-ontem', async (req, res) => {
  try {
    const { porLoja, porLog } = await getResumoDiarioData();
    const totalPedidos = porLoja.reduce((a, r) => a + Number(r.pedidos), 0);
    const totalReceita = porLoja.reduce((a, r) => a + Number(r.receita), 0);
    const totalItens   = porLoja.reduce((a, r) => a + Number(r.itens),   0);
    res.json({
      data: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      totais: { pedidos: totalPedidos, receita: totalReceita, itens: totalItens },
      por_loja: porLoja.map(r => ({ nickname: r.nickname, pedidos: Number(r.pedidos), receita: Number(r.receita), itens: Number(r.itens) })),
      por_logistica: porLog.map(r => ({ tipo: r.tipo, pedidos: Number(r.pedidos) })),
    });
  } catch (e) {
    console.error('[api] /dashboard/resumo-ontem error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/dashboard/top-vendas-dia', async (req, res) => {
  try {
    const rows = await getTopVendas({ hours: 24, limit: 10 });
    res.json({ periodo_horas: 24, itens: rows });
  } catch (e) {
    console.error('[api] /dashboard/top-vendas-dia error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/dashboard/resumo-semanal', async (req, res) => {
  try {
    res.json(await getResumoSemanal());
  } catch (e) {
    console.error('[api] /dashboard/resumo-semanal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Alertas do dia — outliers estatísticos de ontem (mesma lógica do Telegram
// tg_outlier) + itens mais vendidos nas últimas 24h com estoque baixo.
router.get('/dashboard/alertas-dia', async (req, res) => {
  try {
    const [outliers, estoqueCritico] = await Promise.all([
      getOutliersOntem(),
      getEstoqueCriticoTopVendas({ hours: 24, estoqueMax: 15, limit: 10 }),
    ]);
    res.json({ outliers, estoque_critico: estoqueCritico });
  } catch (e) {
    console.error('[api] /dashboard/alertas-dia error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Anúncios / Produtos ────────────────────────────────────
router.get('/anuncios', async (req, res) => {
  const { status = '', search = '', store_id = '', days = '' } = req.query;
  const dateFilter = days ? `AND updated_at >= now() - interval '${Number(days)} days'` : '';
  const { rows } = await pool.query(
    `SELECT ml_id, store_id, title, price, available_quantity, sold_quantity, status, updated_at
     FROM vw_ml_items
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
     FROM vw_ml_items WHERE ($1 = '' OR store_id = $1::bigint) ${dateFilter}`,
    [store_id]
  );
  res.json({ results: rows, summary: summary.rows[0] });
});

router.get('/produtos', async (req, res) => {
  const { search = '', sortBy = 'vendas_desc', days = '', store_id = '' } = req.query;
  const storeFilter = store_id ? `AND i.store_id = ${BigInt(store_id)}` : '';
  const orderMap = {
    vendas_desc:   'i.sold_quantity DESC',
    vendas_asc:    'i.sold_quantity ASC',
    estoque_desc:  'i.available_quantity DESC',
    estoque_asc:   'i.available_quantity ASC',
    receita:       'i.sold_quantity * i.price DESC',
  };
  const orderBy = orderMap[sortBy] || 'i.sold_quantity DESC';
  const periodFilter = days ? `AND o.date_created >= CURRENT_DATE - ${Number(days)}` : '';
  const [{ rows }, kpi] = await Promise.all([
    pool.query(
      `SELECT i.ml_id as id, i.title, i.price,
              i.available_quantity as stock,
              i.sold_quantity as sold_total,
              i.sold_quantity * i.price as revenue_total,
              i.status,
              COALESCE(s.nickname, 'Loja '||i.store_id::text) as loja,
              COALESCE(pr.vendas_periodo, 0)  as sold_periodo,
              COALESCE(pr.receita_periodo, 0) as revenue_periodo,
              COALESCE(NULLIF(promo.original_price,0), NULLIF(i.original_price,0)) as original_price,
              COALESCE(NULLIF(promo.promo_price,0),
                CASE WHEN COALESCE(NULLIF(i.original_price,0),0) > 0 THEN i.price END) as promo_price,
              COALESCE(promo.discount_pct,
                CASE WHEN COALESCE(NULLIF(i.original_price,0),0) > i.price AND i.price > 0
                  THEN ROUND((1 - i.price / i.original_price) * 100, 1) END) as discount_pct
       FROM vw_ml_items i
       LEFT JOIN vw_ml_stores s ON s.id = i.store_id
       LEFT JOIN LATERAL (
         SELECT original_price, promo_price, discount_pct
         FROM promotions pm
         WHERE pm.item_id = i.ml_id AND pm.status = 'started'
         ORDER BY pm.changed_at DESC LIMIT 1
       ) promo ON true
       LEFT JOIN (
         SELECT o.item_id,
                COUNT(*) as vendas_periodo,
                SUM(o.total_amount) as receita_periodo
         FROM vw_ml_orders o
         WHERE o.status != 'cancelled' ${periodFilter}
           ${store_id ? `AND o.store_id = ${BigInt(store_id)}` : ''}
         GROUP BY o.item_id
       ) pr ON pr.item_id = i.ml_id
       WHERE ($1 = '' OR i.title ILIKE '%'||$1||'%')
         ${storeFilter}
       ORDER BY ${orderBy.replace('i.sold_quantity', days ? 'COALESCE(pr.vendas_periodo,0)' : 'i.sold_quantity')} LIMIT 500`,
      [search]
    ),
    pool.query(
      `SELECT COUNT(*) as total,
              SUM(i.available_quantity) as total_estoque,
              SUM(i.sold_quantity) as total_vendas,
              COUNT(*) FILTER (WHERE i.available_quantity = 0) as sem_estoque,
              COUNT(*) FILTER (WHERE i.available_quantity <= 3 AND i.available_quantity > 0) as estoque_baixo
       FROM vw_ml_items i
       WHERE ($1 = '' OR i.title ILIKE '%'||$1||'%') ${storeFilter}`,
      [search]
    )
  ]);
  res.json({ products: rows, kpi: kpi.rows[0] });
});

// ── Produto — detalhe modal ────────────────────────────────
router.get('/produtos/:id/detalhe', async (req, res) => {
  try {
    const { id } = req.params;

    const [itemR, changesR, vendasR, visitasR] = await Promise.all([
      // item + loja + promoção
      pool.query(
        `SELECT i.ml_id, i.title, i.price, i.original_price, i.available_quantity,
                i.sold_quantity, i.status, i.category_id, i.thumbnail, i.permalink,
                COALESCE(i.cost, 0) AS cost,
                COALESCE(s.nickname, 'Loja '||i.store_id::text) AS loja,
                COALESCE(s.imposto_pct, 0) AS imposto_pct,
                COALESCE(NULLIF(promo.original_price,0), NULLIF(i.original_price,0)) AS promo_orig,
                COALESCE(NULLIF(promo.promo_price,0),
                  CASE WHEN COALESCE(NULLIF(i.original_price,0),0) > 0 THEN i.price END) AS promo_price,
                COALESCE(promo.discount_pct,
                  CASE WHEN COALESCE(NULLIF(i.original_price,0),0) > i.price AND i.price > 0
                    THEN ROUND((1 - i.price / i.original_price)*100,1) END) AS discount_pct
         FROM vw_ml_items i
         LEFT JOIN vw_ml_stores s ON s.id = i.store_id
         LEFT JOIN LATERAL (
           SELECT original_price, promo_price, discount_pct FROM promotions
           WHERE item_id = i.ml_id AND status = 'started'
           ORDER BY changed_at DESC LIMIT 1
         ) promo ON true
         WHERE i.ml_id = $1`, [id]),

      // últimas 6 alterações
      pool.query(
        `SELECT changes, changed_at FROM item_changes
         WHERE item_id = $1 ORDER BY changed_at DESC LIMIT 6`, [id]),

      // vendas diárias últimos 30 dias
      pool.query(
        `SELECT date_trunc('day', date_created AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
                COUNT(*) AS pedidos, SUM(total_amount) AS receita
         FROM vw_ml_orders
         WHERE item_id = $1 AND status != 'cancelled'
           AND date_created >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`, [id]),

      // visitas últimos 30 dias
      pool.query(
        `SELECT date, visits FROM item_visits
         WHERE item_id = $1 AND date >= CURRENT_DATE - 30
         ORDER BY date`, [id]),
    ]);

    const item = itemR.rows[0];
    if (!item) return res.status(404).json({ error: 'not found' });

    // totais de vendas (todos os tempos)
    const { rows: totR } = await pool.query(
      `SELECT COUNT(*) AS pedidos_total, SUM(total_amount) AS receita_total
       FROM vw_ml_orders WHERE item_id=$1 AND status!='cancelled'`, [id]);

    res.json({
      item,
      totais: totR[0],
      changes: changesR.rows,
      vendas_diarias: vendasR.rows,
      visitas: visitasR.rows,
    });
  } catch (e) {
    console.error('[api] /produtos/:id/detalhe error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
       FROM vw_ml_orders o LEFT JOIN vw_ml_stores s ON s.id = o.store_id
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
       FROM vw_ml_orders o WHERE 1=1 ${dateFilter}`
    )
  ]);
  res.json({ results: rows, summary: kpi.rows[0] });
});

router.get('/vendas/diarias', async (req, res) => {
  const days = Number(req.query.days) || 30;
  const { rows } = await pool.query(
    `SELECT (date_created AT TIME ZONE 'America/Sao_Paulo')::date as data, COUNT(*) pedidos, SUM(total_amount) bruto
     FROM vw_ml_orders WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - $1::int AND status != 'cancelled'
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  res.json({ rows: rows.map(r => ({ ...r, liquido: Number(r.bruto) * 0.88, taxas: Number(r.bruto) * 0.12 })), summary: {} });
});

router.get('/vendas/detalhado', async (req, res) => {
  try {
  const { store_id = '', status = 'paid', days = 30, search = '', date_from = '', date_to = '' } = req.query;
  const dateFrom = date_from || null;
  const dateTo   = date_to   || null;
  const params = [store_id, status, Number(days), search, dateFrom, dateTo];
  const whereClause = `
     WHERE ($1 = '' OR o.store_id = $1::bigint)
       AND ($2 = '' OR o.status = $2)
       AND ($5::date IS NULL OR o.date_created::date >= $5::date)
       AND ($6::date IS NULL OR o.date_created::date <= $6::date)
       AND ($5::date IS NOT NULL OR o.date_created >= CURRENT_DATE - $3::int)
       AND ($4 = '' OR o.title ILIKE '%'||$4||'%')`;

  // Linhas para a tabela — cap de 1000 (payload/render), não usado para os totais.
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
     FROM vw_ml_orders o
     JOIN vw_ml_stores s ON s.id = o.store_id
     LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
     ${whereClause}
     ORDER BY o.date_created DESC LIMIT 1000`,
    params
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

  // Totais — agregados no banco sobre TODO o range filtrado (sem LIMIT), agrupados
  // por status para separar aprovadas/canceladas. Corrige bug: antes os cards de
  // totais eram somados em cima da mesma lista já cortada em 1000 linhas, então
  // qualquer período/loja com mais de 1000 pedidos mostrava valores incompletos.
  const { rows: aggRows } = await pool.query(
    `SELECT
       o.status,
       COALESCE(SUM(o.total_amount), 0) AS faturamento,
       COALESCE(SUM(COALESCE(i.cost, 0) * o.quantity), 0) AS custo,
       COALESCE(SUM(o.total_amount * COALESCE(s.imposto_pct, 0) / 100), 0) AS imposto,
       COALESCE(SUM(o.ml_fee), 0) AS tarifa,
       COALESCE(SUM(o.shipping_cost), 0) AS frete_comprador,
       COALESCE(SUM(o.shipping_seller_cost), 0) AS frete_vendedor,
       COALESCE(SUM(o.quantity), 0) AS qtd,
       COUNT(*) AS pedidos
     FROM vw_ml_orders o
     JOIN vw_ml_stores s ON s.id = o.store_id
     LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
     ${whereClause}
     GROUP BY o.status`,
    params
  );

  const approvedAgg = aggRows.filter(r => r.status !== 'cancelled');
  const cancelledAgg = aggRows.filter(r => r.status === 'cancelled');
  const sumField = (list, field) => list.reduce((a, r) => a + Number(r[field] || 0), 0);
  const custoTotal = sumField(approvedAgg, 'custo');
  const impostoTotal = sumField(approvedAgg, 'imposto');
  const tarifaTotal = sumField(approvedAgg, 'tarifa');
  const freteCompradorTotal = sumField(approvedAgg, 'frete_comprador');
  const freteVendedorTotal = sumField(approvedAgg, 'frete_vendedor');
  const vendasAprovadas = sumField(approvedAgg, 'faturamento');
  const pedidosAprovados = approvedAgg.reduce((a, r) => a + Number(r.pedidos || 0), 0);

  const summary = {
    vendas_aprovadas: vendasAprovadas,
    vendas_canceladas: sumField(cancelledAgg, 'faturamento'),
    custo_total: custoTotal,
    imposto_total: impostoTotal,
    tarifa_total: tarifaTotal,
    frete_comprador_total: freteCompradorTotal,
    frete_vendedor_total: freteVendedorTotal,
    margem_total: vendasAprovadas - custoTotal - impostoTotal - tarifaTotal - freteCompradorTotal - freteVendedorTotal,
    qtd_aprovadas: sumField(approvedAgg, 'qtd'),
    qtd_canceladas: sumField(cancelledAgg, 'qtd'),
    pedidos_aprovados: pedidosAprovados,
    pedidos_cancelados: cancelledAgg.reduce((a, r) => a + Number(r.pedidos || 0), 0),
    ticket_medio: pedidosAprovados > 0 ? vendasAprovadas / pedidosAprovados : 0,
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
       FROM vw_ml_orders o
       JOIN vw_ml_stores s ON s.id = o.store_id
       LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
       WHERE (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND o.status != 'cancelled'`
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

    // Projeção de faturamento do mês — receita acumulada do mês ÷ dias decorridos × dias no mês
    // (run-rate simples pela média diária real do mês, recalculado todo dia — "sempre por mês").
    const { rows: mesRows } = await pool.query(
      `SELECT COALESCE(SUM(o.total_amount), 0) AS receita_mes
       FROM vw_ml_orders o
       WHERE (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date
         AND o.status != 'cancelled'`
    );
    const receitaMes = Number(mesRows[0]?.receita_mes || 0);
    const agoraBRT = new Date(Date.now() - 3 * 3600 * 1000); // BRT = UTC-3
    const diasDecorridos = agoraBRT.getUTCDate();
    const diasNoMes = new Date(Date.UTC(agoraBRT.getUTCFullYear(), agoraBRT.getUTCMonth() + 1, 0)).getUTCDate();
    const projecaoMes = diasDecorridos > 0 ? (receitaMes / diasDecorridos) * diasNoMes : 0;

    res.json({
      pedidos, itens, receita, lucro, mc_pct: Number(mc_pct.toFixed(2)),
      receita_mes: receitaMes, dias_decorridos: diasDecorridos, dias_no_mes: diasNoMes,
      projecao_mes: Number(projecaoMes.toFixed(2)),
    });
  } catch (e) {
    console.error('[api] /vendas/hoje error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Vendas hoje vs ontem (mesmo horário) ───────────────────
router.get('/vendas/hoje-vs-ontem', async (req, res) => {
  try {
    const { store_id = '' } = req.query;
    const storeFilter = store_id ? `AND o.store_id = ${BigInt(store_id)}` : '';

    // Aritmética UTC pura — BRT = UTC-3
    const BRT = 3 * 3600 * 1000;
    const now = new Date();

    // Meia-noite de hoje em BRT (= UTC+3h do dia corrente em BRT)
    const nowBRTms      = now.getTime() - BRT;
    const d             = new Date(nowBRTms);
    const midnightBRTms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + BRT;

    const hojeInicio  = new Date(midnightBRTms);          // 00:00 BRT hoje
    const hojeFim     = now;                              // agora
    const ontemInicio = new Date(midnightBRTms - 86400000); // 00:00 BRT ontem
    const ontemFim    = new Date(now.getTime() - 86400000); // mesmo horário ontem

    const todayStr = hojeInicio.toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `SELECT
         $5::text AS dia_ref,
         o.date_created,
         o.total_amount, o.ml_fee, o.shipping_cost,
         COALESCE(o.shipping_seller_cost,0) AS shipping_seller_cost,
         o.quantity, COALESCE(i.cost,0) AS custo,
         COALESCE(s.imposto_pct,0) AS imposto_pct,
         CASE WHEN o.date_created >= $1 AND o.date_created < $2 THEN 'hoje'
              WHEN o.date_created >= $3 AND o.date_created < $4 THEN 'ontem'
         END AS periodo
       FROM vw_ml_orders o
       JOIN vw_ml_stores s ON s.id = o.store_id
       LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
       WHERE ((o.date_created >= $1 AND o.date_created < $2)
           OR (o.date_created >= $3 AND o.date_created < $4))
         AND o.status != 'cancelled'
         ${storeFilter}`,
      [hojeInicio.toISOString(), hojeFim.toISOString(),
       ontemInicio.toISOString(), ontemFim.toISOString(),
       todayStr]
    );

    const calc = (r) => {
      const fat = Number(r.total_amount);
      const custo = Number(r.custo) * (Number(r.quantity)||1);
      const imp = fat * (Number(r.imposto_pct)/100);
      const tar = Number(r.ml_fee)||0;
      const fc  = Number(r.shipping_cost)||0;
      const fv  = Number(r.shipping_seller_cost)||0;
      return { receita: fat, lucro: fat - custo - imp - tar - fc - fv };
    };

    const hoje  = { pedidos: 0, receita: 0, lucro: 0, itens: 0 };
    const ontem = { pedidos: 0, receita: 0, lucro: 0, itens: 0 };

    for (const r of rows) {
      const t = r.periodo === 'hoje' ? hoje : ontem;
      const { receita, lucro } = calc(r);
      t.pedidos++;
      t.itens   += Number(r.quantity)||1;
      t.receita += receita;
      t.lucro   += lucro;
    }

    const pct = (a, b) => b > 0 ? Number(((a - b) / b * 100).toFixed(1)) : (a > 0 ? 100 : 0);
    res.json({
      hoje,
      ontem,
      diff: {
        receita_pct: pct(hoje.receita, ontem.receita),
        pedidos_pct: pct(hoje.pedidos, ontem.pedidos),
        lucro_pct:   pct(hoje.lucro,   ontem.lucro),
      }
    });
  } catch (e) {
    console.error('[api] /vendas/hoje-vs-ontem error:', e.message);
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
       FROM vw_ml_orders o
       JOIN vw_ml_stores s ON s.id = o.store_id
       LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
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
       LEFT JOIN vw_ml_stores s ON s.id = q.store_id
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
     FROM messages m LEFT JOIN vw_ml_stores s ON s.id = m.store_id
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
       FROM vw_ml_orders
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
       FROM vw_ml_items i
       LEFT JOIN vw_ml_stores s ON s.id = i.store_id
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
       FROM vw_ml_items i
       LEFT JOIN vw_ml_stores s ON s.id = i.store_id
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
     FROM vw_ml_orders WHERE status='cancelled' ORDER BY date_closed DESC LIMIT 100`
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
     FROM vw_ml_stores ORDER BY nickname`
  );
  res.json({ stores: rows });
});

// ── Contas de outros marketplaces (Amazon; Shopee ainda é stub) ───────────
// Não usam o fluxo OAuth do ML — cadastro manual de refresh_token, sem
// rota de "reconectar" (ver .claude/amazon.md, "Suporte a múltiplas contas").
router.get('/lojas/amazon', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nickname, amazon_marketplace_id, amazon_region, updated_at,
            CASE WHEN refresh_token IS NOT NULL THEN true ELSE false END as has_refresh_token
     FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'AMAZON')
     ORDER BY nickname`
  );
  res.json({ stores: rows });
});

router.post('/lojas/amazon', express.json(), async (req, res) => {
  try {
    const { nickname, refresh_token, amazon_marketplace_id, amazon_region } = req.body || {};
    if (!nickname?.trim() || !refresh_token?.trim()) {
      return res.status(400).json({ error: 'nickname e refresh_token são obrigatórios' });
    }
    const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'AMAZON'`);
    const marketplaceId = mp[0]?.id;
    if (!marketplaceId) return res.status(500).json({ error: 'marketplace AMAZON não cadastrado — rode a migration' });

    // Id sintético na faixa reservada da Amazon (9000000001, 9000000002, ...
    // ver .claude/database.md) — Amazon não tem um id numérico curto natural
    // como o user_id do ML.
    const { rows: maxRow } = await pool.query(
      `SELECT COALESCE(MAX(id), 9000000000) AS max_id FROM stores WHERE id BETWEEN 9000000000 AND 9099999999`
    );
    const newId = (BigInt(maxRow[0].max_id) + 1n).toString();

    await pool.query(
      `INSERT INTO stores (id, nickname, marketplace_id, refresh_token, amazon_marketplace_id, amazon_region, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())`,
      [newId, nickname.trim(), marketplaceId, refresh_token.trim(), amazon_marketplace_id?.trim() || null, amazon_region?.trim() || null]
    );
    res.json({
      ok: true,
      store_id: newId,
      note: 'Conta salva. Reinicie o serviço do worker (ml-worker-novo) para ela começar a sincronizar.',
    });
  } catch (e) {
    console.error('[api] POST /lojas/amazon', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/lojas/amazon/:id', async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM stores WHERE id = $1 AND marketplace_id = (SELECT id FROM marketplaces WHERE code = 'AMAZON') RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'conta Amazon não encontrada' });
  res.json({ ok: true, note: 'Reinicie o worker para a remoção ter efeito na sincronização.' });
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

const TG_NOTIF_KEYS = ['tg_vendas','tg_topvendas','tg_outlier','tg_servicos','tg_recursos','tg_reposicao','tg_perguntas','tg_mensagens','tg_promocoes','tg_devolucoes','tg_anuncios','tg_tarefas','tg_token','tg_fila','tg_429','tg_infra','tg_interval','silence_start','silence_end'];
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

// Relatórios por e-mail (Resend) — credencial (API key/from/to) só via
// .env (ver resendClient.js), aqui só os toggles liga/desliga por relatório.
const EMAIL_NOTIF_KEYS = ['email_resumo', 'email_topvendas', 'email_semanal'];

router.get('/config/email', async (req, res) => {
  const { rows } = await pool.query(`SELECT key, value FROM app_config WHERE key = ANY($1)`, [EMAIL_NOTIF_KEYS]);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const result = { configured: !!(process.env.RESEND_API_KEY && process.env.RESEND_TO_EMAIL) };
  EMAIL_NOTIF_KEYS.forEach(k => { result[k] = map[k] === 'true'; });
  res.json(result);
});

router.patch('/config/email', async (req, res) => {
  const upsert = async (key, val) => pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, String(val)]
  );
  for (const k of EMAIL_NOTIF_KEYS) {
    if (req.body[k] !== undefined) await upsert(k, req.body[k]);
  }
  res.json({ ok: true });
});

router.post('/config/email/test', async (req, res) => {
  try {
    const resend = require('../resendClient');
    if (!resend.isConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY ou RESEND_TO_EMAIL não configurado no .env do servidor' });
    await resend.sendEmail({
      subject: 'Teste — ML Dashboard',
      html: '<p style="font-family:sans-serif">✅ Configuração do Resend funcionando corretamente.</p>',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
  if (!['dailySync','syncVendas','syncMetricas','syncReturns','syncParentItems','syncVisitas','syncPrecos','syncScores','syncNotionTarefas','syncTopVendas','emailDailyReports','emailRelatorioSemanal','checkOutlierEstatistico','checkTaxaDevolucaoAlta','syncShippingStatus'].includes(name)) return res.status(400).json({ error: 'job desconhecido' });
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
       LEFT JOIN vw_ml_stores s ON s.id = p.store_id
       LEFT JOIN vw_ml_items i ON i.ml_id = p.item_id
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
     FROM vw_ml_orders
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
     FROM vw_ml_orders
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
       FROM vw_ml_orders
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
     FROM vw_ml_orders
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
                FROM vw_ml_orders WHERE ${clause1}`, args1),
    pool.query(`SELECT COUNT(*) pedidos, COALESCE(SUM(total_amount),0) receita,
                       CASE WHEN COUNT(*)>0 THEN SUM(total_amount)/COUNT(*) ELSE 0 END avg_ticket,
                       SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelamentos
                FROM vw_ml_orders WHERE ${clause2}`, args2),
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
     FROM vw_ml_orders
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
      FROM vw_ml_orders o
      JOIN vw_ml_stores s ON s.id = o.store_id
      -- resolve item_id uma vez (CTE-inline)
      CROSS JOIN LATERAL (
        SELECT COALESCE(o.item_id, o.raw_data->'order_items'->0->'item'->>'id') AS iid
      ) ids
      -- busca título no catálogo quando orders.title é NULL
      LEFT JOIN vw_ml_items i ON i.ml_id = ids.iid AND i.store_id = o.store_id
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

// ── Análise de Vendas do Mês (BI) ────────────────────────────
// Sem normalização por dia útil (decisão explícita do usuário — todo dia
// conta igual). Toda a matemática (regressão, aceleração, projeção) é
// feita em JS depois de 2 queries agregadas por dia — mantém o SQL simples
// e a lógica testável. Ver .claude/business-rules.md para as fórmulas.
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); } // month 1-indexed

// Escada de status reaproveitada pelo Dia Ideal e pelo Termômetro por Horário
// — mesmos limiares (±5%/±20%), um único lugar pra manter em sincronia.
function statusDeDiferenca(pct) {
  return pct >= 20 ? 'muito_acima'
    : pct >= 5 ? 'acima'
    : pct >= -5 ? 'dentro_da_media'
    : pct >= -20 ? 'abaixo'
    : 'muito_abaixo';
}

function linearRegression(points) {
  // points: [{x, y}] — mínimos quadrados simples
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y || 0 };
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const meanX = sumX / n, meanY = sumY / n;
  const num = points.reduce((a, p) => a + (p.x - meanX) * (p.y - meanY), 0);
  const den = points.reduce((a, p) => a + (p.x - meanX) ** 2, 0);
  const slope = den !== 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

function buildDiasArray(rows, ano, mes, hoje) {
  // Preenche 1..N dias do mês com receita/pedidos (zero se não houve venda),
  // e marca `ocorrido:false` para dias futuros (mês corrente ainda em curso)
  // — não confundir "zero vendas" com "dia ainda não aconteceu".
  const total = daysInMonth(ano, mes);
  const isMesAtualReal = hoje.getFullYear() === ano && (hoje.getMonth() + 1) === mes;
  const ultimoDiaOcorrido = isMesAtualReal ? hoje.getDate() : total;
  const byDay = new Map(rows.map(r => [Number(r.dia), r]));
  const dias = [];
  for (let d = 1; d <= total; d++) {
    const r = byDay.get(d);
    const ocorrido = d <= ultimoDiaOcorrido;
    dias.push({
      dia: d,
      receita: ocorrido ? Number(r?.receita || 0) : null,
      pedidos: ocorrido ? Number(r?.pedidos || 0) : null,
      ticket_medio: ocorrido && Number(r?.pedidos || 0) > 0 ? Number(r.receita) / Number(r.pedidos) : (ocorrido ? 0 : null),
      ocorrido,
    });
  }
  return { dias, totalDias: total, ultimoDiaOcorrido };
}

router.get('/analises/vendas-mes', async (req, res) => {
  try {
    const { store_id = '', item_id = '' } = req.query;
    const hoje = new Date();
    const ano  = Number(req.query.year)  || hoje.getFullYear();
    const mes  = Number(req.query.month) || (hoje.getMonth() + 1); // 1-indexed

    const inicioAtual     = new Date(ano, mes - 1, 1);
    const inicioAnterior  = new Date(ano, mes - 2, 1);
    const inicioRetrasado = new Date(ano, mes - 3, 1);
    const inicioHistorico = new Date(ano, mes - 13, 1); // 12 meses antes do início do mês atual
    const fimAtual        = new Date(ano, mes, 1);

    // $2 = store_id, $4 = item_id — mesmos placeholders reaproveitados nas 3 queries desta rota.
    const storeFilter = `AND ($2 = '' OR o.store_id = $2::bigint) AND ($4 = '' OR o.item_id = $4)`;

    // Query 1: os 3 meses de comparação, numa passada só
    const { rows: comparRows } = await pool.query(
      `SELECT date_created::date AS d,
              EXTRACT(YEAR FROM date_created)::int AS ano,
              EXTRACT(MONTH FROM date_created)::int AS mes,
              EXTRACT(DAY FROM date_created)::int AS dia,
              SUM(total_amount) AS receita, COUNT(*) AS pedidos
       FROM vw_ml_orders o
       WHERE o.status != 'cancelled'
         AND o.date_created >= $1 AND o.date_created < $3
         ${storeFilter}
       GROUP BY 1,2,3,4`,
      [inicioRetrasado, store_id, fimAtual, item_id]
    );
    const rowsAtual     = comparRows.filter(r => r.ano === ano && r.mes === mes);
    const rowsAnterior  = comparRows.filter(r => { const d = new Date(ano, mes - 2, 1); return r.ano === d.getFullYear() && r.mes === d.getMonth() + 1; });
    const rowsRetrasado = comparRows.filter(r => { const d = new Date(ano, mes - 3, 1); return r.ano === d.getFullYear() && r.mes === d.getMonth() + 1; });

    const mesAtual     = buildDiasArray(rowsAtual,     ano, mes,               hoje);
    const anoAnt       = new Date(ano, mes - 2, 1);
    const mesAnterior  = buildDiasArray(rowsAnterior,  anoAnt.getFullYear(),  anoAnt.getMonth() + 1,  hoje);
    const anoRetr      = new Date(ano, mes - 3, 1);
    const mesRetrasado = buildDiasArray(rowsRetrasado, anoRetr.getFullYear(), anoRetr.getMonth() + 1, hoje);

    // Query 2: média histórica por dia-do-mês, 12 meses antes do mês selecionado.
    // Inclui lucro (mesma fórmula de margem de GET /api/vendas/detalhado, ver finance.md)
    // e maior/menor/meses_analisados — usados pelo Calendário de Sazonalidade e Dia Ideal.
    const { rows: histRaw } = await pool.query(
      `SELECT dia, AVG(receita) AS media, COALESCE(STDDEV_POP(receita), 0) AS desvio,
              AVG(pedidos) AS media_pedidos, AVG(lucro) AS media_lucro,
              MAX(receita) AS maior, MIN(receita) AS menor, COUNT(*) AS meses_analisados
       FROM (
         SELECT o.date_created::date AS d, EXTRACT(DAY FROM o.date_created)::int AS dia,
                SUM(o.total_amount) AS receita, COUNT(*) AS pedidos,
                SUM(
                  o.total_amount
                  - COALESCE(i.cost, 0) * o.quantity
                  - o.total_amount * COALESCE(s.imposto_pct, 0) / 100
                  - COALESCE(o.ml_fee, 0)
                  - COALESCE(o.shipping_cost, 0)
                  - COALESCE(o.shipping_seller_cost, 0)
                ) AS lucro
         FROM vw_ml_orders o
         JOIN vw_ml_stores s ON s.id = o.store_id
         LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id AND i.store_id = o.store_id
         WHERE o.status != 'cancelled'
           AND o.date_created >= $1 AND o.date_created < $3
           ${storeFilter}
         GROUP BY 1,2
       ) daily
       GROUP BY dia ORDER BY dia`,
      [inicioHistorico, store_id, inicioAtual, item_id]
    );
    const histByDay = new Map(histRaw.map(r => [Number(r.dia), {
      media: Number(r.media), desvio: Number(r.desvio), media_pedidos: Number(r.media_pedidos),
      media_lucro: Number(r.media_lucro || 0), maior: Number(r.maior || 0), menor: Number(r.menor || 0),
      meses_analisados: Number(r.meses_analisados || 0),
    }]));
    const mediaHistorica = Array.from({ length: mesAtual.totalDias }, (_, i) => {
      const d = i + 1;
      const h = histByDay.get(d) || { media: 0, desvio: 0, media_pedidos: 0, media_lucro: 0, maior: 0, menor: 0, meses_analisados: 0 };
      return {
        dia: d, media: h.media, desvio: h.desvio, media_pedidos: h.media_pedidos, media_lucro: h.media_lucro,
        maior: h.maior, menor: h.menor, meses_analisados: h.meses_analisados,
        banda_min: Math.max(0, h.media - h.desvio), banda_max: h.media + h.desvio,
      };
    });
    const mediaGeral = mediaHistorica.length ? mediaHistorica.reduce((a, m) => a + m.media, 0) / mediaHistorica.length : 0;

    // ── Sazonalidade: ranking histórico, estrelas por percentil, participação % ──
    // Estrelas: top 20% dos dias (por média histórica) = 5, próximos 20% = 4, ... até 1.
    // Mesmos objetos de `mediaHistorica` — ordenar a cópia seta `ranking`/`estrelas`
    // por referência, sem precisar reordenar `mediaHistorica` (que fica por dia).
    const somaMediaHist = mediaHistorica.reduce((a, m) => a + m.media, 0);
    const ordenadoPorMedia = [...mediaHistorica].sort((a, b) => b.media - a.media);
    const nDiasHist = mediaHistorica.length;
    ordenadoPorMedia.forEach((m, i) => {
      m.ranking = i + 1;
      const posPct = nDiasHist > 0 ? i / nDiasHist : 0;
      m.estrelas = posPct < 0.2 ? 5 : posPct < 0.4 ? 4 : posPct < 0.6 ? 3 : posPct < 0.8 ? 2 : 1;
      m.participacao_pct = somaMediaHist > 0 ? Number((m.media / somaMediaHist * 100).toFixed(2)) : 0;
    });
    const sazonalidadeTop10    = ordenadoPorMedia.slice(0, 10);
    const sazonalidadeBottom10 = [...ordenadoPorMedia].reverse().slice(0, 10);

    // ── KPIs (só dias já ocorridos do mês atual) ──────────────
    const diasOcorridosAtual = mesAtual.dias.filter(d => d.ocorrido);
    const receitaAcumulada = diasOcorridosAtual.reduce((a, d) => a + d.receita, 0);
    const pedidosTotal     = diasOcorridosAtual.reduce((a, d) => a + d.pedidos, 0);
    const ticketMedio      = pedidosTotal > 0 ? receitaAcumulada / pedidosTotal : 0;

    // Crescimento vs mês anterior — mesmo nº de dias decorridos em ambos, comparação justa
    const nDias = diasOcorridosAtual.length;
    const receitaAnteriorMesmoPeriodo = mesAnterior.dias.slice(0, Math.min(nDias, mesAnterior.totalDias))
      .reduce((a, d) => a + (d.receita || 0), 0);
    const crescimentoPct = receitaAnteriorMesmoPeriodo > 0
      ? ((receitaAcumulada - receitaAnteriorMesmoPeriodo) / receitaAnteriorMesmoPeriodo) * 100
      : (receitaAcumulada > 0 ? 100 : 0);

    // Sparkline dos KPIs = receita diária dos dias já ocorridos
    const sparkline = diasOcorridosAtual.map(d => d.receita);

    // ── Rankings ───────────────────────────────────────────────
    const diasComVenda = [...diasOcorridosAtual].sort((a, b) => b.receita - a.receita);
    const top10 = diasComVenda.slice(0, 10);
    const bottom10 = [...diasComVenda].sort((a, b) => a.receita - b.receita).slice(0, 10);

    // ── Insights ────────────────────────────────────────────────
    // Tendência: regressão linear sobre os dias já ocorridos
    const pontosRegressao = diasOcorridosAtual.map(d => ({ x: d.dia, y: d.receita }));
    const { slope, intercept } = linearRegression(pontosRegressao);
    const tendencia = {
      slope: Number(slope.toFixed(2)),
      intercept: Number(intercept.toFixed(2)),
      direcao: Math.abs(slope) < 1 ? 'estável' : (slope > 0 ? 'alta' : 'queda'),
    };

    // Índice de aceleração: variação da taxa de crescimento dia-a-dia entre 1ª e 2ª metade do período decorrido
    function taxaCrescimentoMedia(dias) {
      if (dias.length < 2) return 0;
      const variacoes = [];
      for (let i = 1; i < dias.length; i++) {
        const prev = dias[i - 1].receita, cur = dias[i].receita;
        if (prev > 0) variacoes.push((cur - prev) / prev * 100);
      }
      return variacoes.length ? variacoes.reduce((a, v) => a + v, 0) / variacoes.length : 0;
    }
    const meio = Math.floor(diasOcorridosAtual.length / 2);
    const taxa1 = taxaCrescimentoMedia(diasOcorridosAtual.slice(0, meio));
    const taxa2 = taxaCrescimentoMedia(diasOcorridosAtual.slice(meio));
    const aceleracao = Number((taxa2 - taxa1).toFixed(1)); // positivo = acelerando, negativo = desacelerando

    // Melhor/pior semana (blocos de 7 dias corridos dentro do mês)
    const semanas = [];
    for (let inicio = 1; inicio <= mesAtual.totalDias; inicio += 7) {
      const fim = Math.min(inicio + 6, mesAtual.totalDias);
      const diasSemana = diasOcorridosAtual.filter(d => d.dia >= inicio && d.dia <= fim);
      if (diasSemana.length) semanas.push({ inicio, fim, receita: diasSemana.reduce((a, d) => a + d.receita, 0) });
    }
    const melhorSemana = semanas.length ? semanas.reduce((a, s) => s.receita > a.receita ? s : a) : null;
    const piorSemana   = semanas.length ? semanas.reduce((a, s) => s.receita < a.receita ? s : a) : null;

    // Concentração — % da receita nos 5 melhores dias
    const top5Receita = top10.slice(0, 5).reduce((a, d) => a + d.receita, 0);
    const concentracaoTop5Pct = receitaAcumulada > 0 ? Number((top5Receita / receitaAcumulada * 100).toFixed(1)) : 0;

    // Acumulado — curva de receita acumulada, atual vs anterior, mesmo nº de dias
    const acumuladoAtual = [];
    let acAtual = 0;
    diasOcorridosAtual.forEach(d => { acAtual += d.receita; acumuladoAtual.push({ dia: d.dia, valor: acAtual }); });
    const acumuladoAnterior = [];
    let acAnt = 0;
    mesAnterior.dias.slice(0, nDias).forEach(d => { acAnt += (d.receita || 0); acumuladoAnterior.push({ dia: d.dia, valor: acAnt }); });
    const acumuladoDiffPct = acAnt > 0 ? Number(((acAtual - acAnt) / acAnt * 100).toFixed(1)) : 0;

    // Projeção de fechamento — dias restantes projetados pela reta de regressão (piso em 0)
    let projecaoFechamento = receitaAcumulada;
    for (let d = mesAtual.ultimoDiaOcorrido + 1; d <= mesAtual.totalDias; d++) {
      projecaoFechamento += Math.max(0, intercept + slope * d);
    }
    projecaoFechamento = Number(projecaoFechamento.toFixed(2));

    // Sugestão de estoque — top 5 itens por unidades vendidas no mês, cruzado com estoque atual
    const { rows: topItens } = await pool.query(
      `SELECT o.item_id, COALESCE(MAX(o.title), MAX(i.title)) AS title,
              SUM(o.quantity) AS unidades, MAX(i.available_quantity) AS estoque
       FROM vw_ml_orders o
       LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id AND i.store_id = o.store_id
       WHERE o.status != 'cancelled' AND o.item_id IS NOT NULL
         AND o.date_created >= $1 AND o.date_created < $3
         ${storeFilter}
       GROUP BY o.item_id ORDER BY unidades DESC LIMIT 5`,
      [inicioAtual, store_id, fimAtual, item_id]
    );
    const sugestaoEstoque = topItens
      .filter(r => r.estoque != null && Number(r.estoque) <= 15)
      .map(r => ({ item_id: r.item_id, title: r.title, unidades_vendidas: Number(r.unidades), estoque_atual: Number(r.estoque) }));

    // Sugestão de anúncios — dias historicamente mais fracos (bottom 5 do ranking do mês)
    const sugestaoAnuncios = bottom10.slice(0, 5).map(d => ({ dia: d.dia, receita: d.receita }));

    // ── Dia Ideal — só quando o mês/ano selecionado é o mês corrente de verdade ──
    // "Esperado" = média histórica do mesmo dia-do-mês (12 meses); "atual" = receita
    // de hoje até agora (já está em mesAtual, porque hoje conta como `ocorrido`).
    let diaIdeal = null;
    if (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1) {
      const diaAtualNum = hoje.getDate();
      const h = mediaHistorica.find(m => m.dia === diaAtualNum);
      const atualReceita = mesAtual.dias.find(d => d.dia === diaAtualNum)?.receita ?? 0;
      if (h && h.meses_analisados > 0) {
        const diferenca = atualReceita - h.media;
        const diferencaPct = h.media > 0 ? (diferenca / h.media) * 100 : (atualReceita > 0 ? 100 : 0);
        // "Esperado" é o total do dia INTEIRO (média histórica de dias já fechados);
        // "atual" é só o parcial de hoje até agora — o dia ainda não terminou.
        // pct_dia_decorrido deixa o frontend deixar isso explícito (não é "abaixo
        // da meta", é "ainda faltam Y% do dia" — ver decisions.md).
        const minutosDoDia = hoje.getHours() * 60 + hoje.getMinutes();
        const pctDiaDecorrido = Number(((minutosDoDia / 1440) * 100).toFixed(1));
        diaIdeal = {
          dia: diaAtualNum,
          esperado: Number(h.media.toFixed(2)),
          atual: Number(atualReceita.toFixed(2)),
          diferenca: Number(diferenca.toFixed(2)),
          diferenca_pct: Number(diferencaPct.toFixed(1)),
          status: statusDeDiferenca(diferencaPct),
          historico: { media: h.media, maior: h.maior, menor: h.menor, desvio: h.desvio, meses_analisados: h.meses_analisados },
          hora_atual: `${String(hoje.getHours()).padStart(2, '0')}:${String(hoje.getMinutes()).padStart(2, '0')}`,
          pct_dia_decorrido: pctDiaDecorrido,
        };
      }
    }

    // ── Termômetro por horário — complementa o Dia Ideal (que só fecha ao fim
    // do dia) com um sinal de "estou pacing bem AGORA": compara a receita de
    // hoje até este exato horário (minutoAtual) contra (1) a média dos
    // últimos 30 dias até o mesmo horário e (2) ontem até o mesmo horário.
    // Filtro por hora:minuto (não por hora cheia) pra ser comparável ao
    // corte exato de "agora", não arredondado pra baixo/cima.
    let termometroHorario = null;
    if (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1) {
      const diaAtualNum = hoje.getDate();
      const atualReceita = mesAtual.dias.find(d => d.dia === diaAtualNum)?.receita ?? 0;
      const minutoAtual = hoje.getHours() * 60 + hoje.getMinutes();
      const filtroHorarioLojaItem = `AND (EXTRACT(HOUR FROM o.date_created)*60 + EXTRACT(MINUTE FROM o.date_created)) <= $1
             AND ($2 = '' OR o.store_id = $2::bigint) AND ($3 = '' OR o.item_id = $3)`;
      const [{ rows: media30dRows }, { rows: ontemRows }] = await Promise.all([
        pool.query(
          `SELECT AVG(receita) AS media, COUNT(*) AS dias_analisados
           FROM (
             SELECT o.date_created::date AS d, SUM(o.total_amount) AS receita
             FROM vw_ml_orders o
             WHERE o.status != 'cancelled'
               AND o.date_created >= (now() - interval '30 days')
               AND o.date_created <  date_trunc('day', now())
               ${filtroHorarioLojaItem}
             GROUP BY 1
           ) diario`,
          [minutoAtual, store_id, item_id]
        ),
        pool.query(
          `SELECT COALESCE(SUM(o.total_amount), 0) AS receita
           FROM vw_ml_orders o
           WHERE o.status != 'cancelled'
             AND o.date_created >= (date_trunc('day', now()) - interval '1 day')
             AND o.date_created <  date_trunc('day', now())
             ${filtroHorarioLojaItem}`,
          [minutoAtual, store_id, item_id]
        ),
      ]);

      const media30d = Number(media30dRows[0]?.media || 0);
      const diasAnalisados30d = Number(media30dRows[0]?.dias_analisados || 0);
      const ontem = Number(ontemRows[0]?.receita || 0);

      const diferenca30d = atualReceita - media30d;
      const diferenca30dPct = media30d > 0 ? (diferenca30d / media30d) * 100 : (atualReceita > 0 ? 100 : 0);
      const diferencaOntem = atualReceita - ontem;
      const diferencaOntemPct = ontem > 0 ? (diferencaOntem / ontem) * 100 : (atualReceita > 0 ? 100 : 0);

      termometroHorario = {
        hora_atual: `${String(hoje.getHours()).padStart(2, '0')}:${String(hoje.getMinutes()).padStart(2, '0')}`,
        atual: Number(atualReceita.toFixed(2)),
        media_30d: {
          valor: Number(media30d.toFixed(2)),
          dias_analisados: diasAnalisados30d,
          diferenca: Number(diferenca30d.toFixed(2)),
          diferenca_pct: Number(diferenca30dPct.toFixed(1)),
          status: statusDeDiferenca(diferenca30dPct),
        },
        ontem: {
          valor: Number(ontem.toFixed(2)),
          diferenca: Number(diferencaOntem.toFixed(2)),
          diferenca_pct: Number(diferencaOntemPct.toFixed(1)),
          status: statusDeDiferenca(diferencaOntemPct),
        },
      };
    }

    res.json({
      periodo: { ano, mes, total_dias: mesAtual.totalDias, ultimo_dia_ocorrido: mesAtual.ultimoDiaOcorrido },
      kpis: {
        receita_acumulada: receitaAcumulada, pedidos: pedidosTotal, ticket_medio: Number(ticketMedio.toFixed(2)),
        crescimento_pct: Number(crescimentoPct.toFixed(1)), sparkline,
      },
      mes_atual: mesAtual.dias,
      mes_anterior: mesAnterior.dias,
      mes_retrasado: mesRetrasado.dias,
      media_historica: mediaHistorica,
      media_geral: Number(mediaGeral.toFixed(2)),
      ranking_top10: top10,
      ranking_bottom10: bottom10,
      dia_ideal: diaIdeal,
      termometro_horario: termometroHorario,
      sazonalidade: { top10: sazonalidadeTop10, bottom10: sazonalidadeBottom10 },
      insights: {
        tendencia, aceleracao, melhor_semana: melhorSemana, pior_semana: piorSemana,
        concentracao_top5_pct: concentracaoTop5Pct,
        acumulado_atual: acumuladoAtual, acumulado_anterior: acumuladoAnterior, acumulado_diff_pct: acumuladoDiffPct,
        projecao_fechamento: projecaoFechamento,
        sugestao_estoque: sugestaoEstoque, sugestao_anuncios: sugestaoAnuncios,
      },
    });
  } catch (e) {
    console.error('[api] /analises/vendas-mes error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Drawer de sazonalidade: evolução mês a mês + produtos mais vendidos desse
// dia-do-mês, na mesma janela histórica de 12 meses da rota principal.
router.get('/analises/vendas-mes/dia-historico', async (req, res) => {
  try {
    const { store_id = '' } = req.query;
    const dia  = Number(req.query.dia);
    const ano  = Number(req.query.year)  || new Date().getFullYear();
    const mes  = Number(req.query.month) || (new Date().getMonth() + 1);
    if (!dia || dia < 1 || dia > 31) return res.status(400).json({ error: 'dia é obrigatório (1-31)' });

    const inicioAtual     = new Date(ano, mes - 1, 1);
    const inicioHistorico = new Date(ano, mes - 13, 1);
    const storeFilter = `AND ($3 = '' OR o.store_id = $3::bigint)`;

    const { rows: evolucao } = await pool.query(
      `SELECT EXTRACT(YEAR FROM o.date_created)::int AS ano, EXTRACT(MONTH FROM o.date_created)::int AS mes,
              SUM(o.total_amount) AS receita, COUNT(*) AS pedidos
       FROM vw_ml_orders o
       WHERE o.status != 'cancelled'
         AND EXTRACT(DAY FROM o.date_created) = $4
         AND o.date_created >= $1 AND o.date_created < $2
         ${storeFilter}
       GROUP BY 1,2 ORDER BY 1,2`,
      [inicioHistorico, inicioAtual, store_id, dia]
    );

    const { rows: produtos } = await pool.query(
      `SELECT o.item_id, COALESCE(MAX(o.title), MAX(i.title)) AS title,
              SUM(o.quantity) AS unidades, SUM(o.total_amount) AS receita
       FROM vw_ml_orders o
       LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id AND i.store_id = o.store_id
       WHERE o.status != 'cancelled' AND o.item_id IS NOT NULL
         AND EXTRACT(DAY FROM o.date_created) = $4
         AND o.date_created >= $1 AND o.date_created < $2
         ${storeFilter}
       GROUP BY o.item_id ORDER BY unidades DESC LIMIT 10`,
      [inicioHistorico, inicioAtual, store_id, dia]
    );

    res.json({
      dia,
      evolucao: evolucao.map(r => ({ ano: r.ano, mes: r.mes, receita: Number(r.receita), pedidos: Number(r.pedidos) })),
      produtos_mais_vendidos: produtos.map(r => ({ item_id: r.item_id, title: r.title, unidades: Number(r.unidades), receita: Number(r.receita) })),
    });
  } catch (e) {
    console.error('[api] /analises/vendas-mes/dia-historico error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Drill-down: pedidos de um dia específico (heatmap/gráfico 1 → modal)
router.get('/analises/vendas-mes/dia', async (req, res) => {
  try {
    const { date = '', store_id = '' } = req.query;
    if (!date) return res.status(400).json({ error: 'date é obrigatório (YYYY-MM-DD)' });
    const { rows } = await pool.query(
      `SELECT o.ml_id, o.title, o.item_id, s.nickname AS conta, o.quantity, o.unit_price,
              o.total_amount, o.status, o.date_created
       FROM vw_ml_orders o
       JOIN vw_ml_stores s ON s.id = o.store_id
       WHERE o.date_created::date = $1::date
         AND ($2 = '' OR o.store_id = $2::bigint)
         AND o.status != 'cancelled'
       ORDER BY o.date_created DESC`,
      [date, store_id]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api] /analises/vendas-mes/dia error:', e.message);
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
     FROM vw_ml_orders
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
     FROM vw_ml_orders WHERE buyer_nickname = $1 ORDER BY date_created DESC LIMIT 100`,
    [req.params.nickname]
  );
  res.json({ pedidos: rows });
});

// ── Alertas faltando ───────────────────────────────────────
router.get('/alertas/devolucoes', async (req, res) => {
  try {
    const { store_id = '', q = '', date_from = '', date_to = '' } = req.query;
    const where = [`($1 = '' OR r.store_id = $1::bigint)`];
    const params = [store_id];
    if (q) { params.push(`%${q}%`); where.push(`(r.order_id::text ILIKE $${params.length} OR r.buyer_nickname ILIKE $${params.length} OR r.title ILIKE $${params.length} OR i.title ILIKE $${params.length})`); }
    if (date_from) { params.push(date_from); where.push(`r.date >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   where.push(`r.date <= $${params.length}`); }

    // Pedidos do mesmo período/loja (não a mesma busca livre `q` — "taxa de
    // devolução" é sobre o volume total de pedidos, não sobre pedidos que
    // batem com um termo de busca de devolução) — usado pra Taxa de
    // Devolução = devoluções ÷ pedidos, ver business-rules.md.
    const pedidosWhere = [`o.status != 'cancelled'`, `($1 = '' OR o.store_id = $1::bigint)`];
    const pedidosParams = [store_id];
    if (date_from) { pedidosParams.push(date_from); pedidosWhere.push(`o.date_created >= $${pedidosParams.length}`); }
    if (date_to)   { pedidosParams.push(date_to);   pedidosWhere.push(`o.date_created <= $${pedidosParams.length}`); }

    const [{ rows }, { rows: pedidosPorLojaRows }, { rows: pedidosPorLogisticaRows }] = await Promise.all([
      pool.query(
        `SELECT r.id, r.store_id, s.nickname as conta, r.order_id,
                r.buyer_nickname, r.title, r.reason, r.amount, r.status, r.date, r.note, r.prejuizo,
                COALESCE(cr.detail, r.reason) AS reason_detail,
                r.raw_data,
                r.raw_data->>'stage' AS stage,
                r.raw_data->>'type' AS type,
                r.raw_data->>'last_updated' AS last_updated,
                o.item_id, o.quantity AS order_quantity, o.unit_price, o.total_amount AS order_amount,
                o.shipping_type, o.date_created AS order_date,
                COALESCE(i.title, r.title) AS item_title, i.thumbnail AS item_thumbnail, i.permalink AS item_permalink
         FROM returns r
         LEFT JOIN vw_ml_stores s ON s.id = r.store_id
         LEFT JOIN claim_reasons cr ON cr.id = r.reason
         LEFT JOIN vw_ml_orders o ON o.ml_id = r.order_id
         LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.date DESC LIMIT 200`,
        params
      ),
      // Pedidos agrupados por loja — alimenta pedidos_total (soma) e Taxa por
      // Loja (comparação lado a lado quando "Todas as lojas" está selecionado).
      pool.query(
        `SELECT o.store_id, s.nickname AS conta, COUNT(*) AS pedidos
         FROM vw_ml_orders o
         LEFT JOIN vw_ml_stores s ON s.id = o.store_id
         WHERE ${pedidosWhere.join(' AND ')}
         GROUP BY o.store_id, s.nickname`,
        pedidosParams
      ),
      // Pedidos agrupados por tipo de envio cru — o bucket
      // Flex/Mercado Envios/Full é feito no frontend (logLabel()), mesma
      // classificação já usada na tabela, pra não duplicar a lógica aqui.
      pool.query(
        `SELECT COALESCE(o.shipping_type, '') AS shipping_type, COUNT(*) AS pedidos
         FROM vw_ml_orders o
         WHERE ${pedidosWhere.join(' AND ')}
         GROUP BY o.shipping_type`,
        pedidosParams
      ),
    ]);

    const comPrejuizo = rows.filter(r => r.prejuizo != null);
    const pedidosTotal = pedidosPorLojaRows.reduce((s, p) => s + Number(p.pedidos), 0);
    const taxaDevolucaoPct = pedidosTotal > 0 ? (rows.length / pedidosTotal) * 100 : (rows.length > 0 ? 100 : 0);

    // Ranking de produtos — só busca pedidos dos itens que efetivamente
    // aparecem nas devoluções do período (não o catálogo inteiro), item por
    // item seria N+1; um IN/ANY só com os item_ids relevantes.
    const itemIds = [...new Set(rows.map(r => r.item_id).filter(Boolean))];
    let pedidosPorItemRows = [];
    if (itemIds.length) {
      const { rows: r2 } = await pool.query(
        `SELECT o.item_id, COUNT(*) AS pedidos
         FROM vw_ml_orders o
         WHERE o.item_id = ANY($1) AND ${pedidosWhere.map((w, i) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)).join(' AND ')}
         GROUP BY o.item_id`,
        [itemIds, ...pedidosParams]
      );
      pedidosPorItemRows = r2;
    }
    const pedidosPorItem = new Map(pedidosPorItemRows.map(r => [r.item_id, Number(r.pedidos)]));
    const devPorItem = new Map();
    rows.forEach(r => {
      if (!r.item_id) return;
      const cur = devPorItem.get(r.item_id) || { item_id: r.item_id, item_title: r.item_title, conta: r.conta, devolucoes: 0 };
      cur.devolucoes += 1;
      devPorItem.set(r.item_id, cur);
    });
    const rankingProdutos = [...devPorItem.values()].map(p => {
      const pedidos = pedidosPorItem.get(p.item_id) || 0;
      return { ...p, pedidos, taxa_pct: pedidos > 0 ? Number(((p.devolucoes / pedidos) * 100).toFixed(2)) : null };
    }).sort((a, b) => b.devolucoes - a.devolucoes).slice(0, 10);

    // Taxa por Loja — devoluções vêm de `rows` (já carregadas), pedidos da
    // query agrupada acima. Só faz sentido mostrar quando não há um único
    // store_id já filtrado (aí seria uma linha só, redundante com o KPI).
    const devPorLoja = new Map();
    rows.forEach(r => {
      const cur = devPorLoja.get(r.store_id) || { store_id: r.store_id, conta: r.conta, devolucoes: 0 };
      cur.devolucoes += 1;
      devPorLoja.set(r.store_id, cur);
    });
    const taxaPorLoja = pedidosPorLojaRows.map(p => {
      const devolucoes = devPorLoja.get(p.store_id)?.devolucoes || 0;
      const pedidos = Number(p.pedidos);
      return { store_id: p.store_id, conta: p.conta, devolucoes, pedidos, taxa_pct: pedidos > 0 ? Number(((devolucoes / pedidos) * 100).toFixed(2)) : null };
    }).sort((a, b) => b.taxa_pct - a.taxa_pct);

    const summary = {
      in_analysis: rows.filter(r => r.status === 'analysis' || r.status === 'opened').length,
      approved:    rows.filter(r => r.status === 'approved' || r.status === 'resolved').length,
      rejected:    rows.filter(r => r.status === 'rejected' || r.status === 'closed').length,
      total_value: rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0),
      total:       rows.length,
      prejuizo_total: comPrejuizo.reduce((s, r) => s + parseFloat(r.prejuizo || 0), 0),
      prejuizo_qtd:   comPrejuizo.length,
      pedidos_total:      pedidosTotal,
      taxa_devolucao_pct: Number(taxaDevolucaoPct.toFixed(2)),
      ranking_produtos:   rankingProdutos,
      taxa_por_loja:      taxaPorLoja,
      pedidos_por_logistica: pedidosPorLogisticaRows.map(r => ({ shipping_type: r.shipping_type, pedidos: Number(r.pedidos) })),
    };
    res.json({ items: rows, summary });
  } catch (e) {
    console.error('[/alertas/devolucoes]', e.message);
    res.status(500).json({ error: e.message, items: [], summary: {} });
  }
});

// Série diária zero-fill (devoluções abertas no dia + pedidos do dia + taxa)
// — pra ver se a taxa está piorando/melhorando, não só a foto do período
// filtrado. `days` é independente do filtro de data da tabela principal
// (mesmo padrão de /api/embalagem/historico), só respeita store_id.
router.get('/alertas/devolucoes/evolucao', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const { store_id = '' } = req.query;
    const { rows } = await pool.query(
      `WITH dias AS (
         SELECT generate_series((current_date - ($1::int - 1)), current_date, interval '1 day')::date AS d
       ), devol AS (
         SELECT r.date::date AS d, COUNT(*) AS n
         FROM returns r
         WHERE r.date >= (current_date - ($1::int - 1)) AND ($2 = '' OR r.store_id = $2::bigint)
         GROUP BY 1
       ), pedidos AS (
         SELECT o.date_created::date AS d, COUNT(*) AS n
         FROM vw_ml_orders o
         WHERE o.status != 'cancelled' AND o.date_created >= (current_date - ($1::int - 1)) AND ($2 = '' OR o.store_id = $2::bigint)
         GROUP BY 1
       )
       SELECT dias.d AS date, COALESCE(devol.n, 0)::int AS devolucoes, COALESCE(pedidos.n, 0)::int AS pedidos
       FROM dias
       LEFT JOIN devol ON devol.d = dias.d
       LEFT JOIN pedidos ON pedidos.d = dias.d
       ORDER BY dias.d`,
      [days, store_id]
    );
    const dias = rows.map(r => ({
      date: r.date, devolucoes: r.devolucoes, pedidos: r.pedidos,
      taxa_pct: r.pedidos > 0 ? Number(((r.devolucoes / r.pedidos) * 100).toFixed(2)) : null,
    }));
    res.json({ dias });
  } catch (e) {
    console.error('[/alertas/devolucoes/evolucao]', e.message);
    res.status(500).json({ error: e.message, dias: [] });
  }
});

router.patch('/alertas/devolucoes/:id/note', async (req, res) => {
  try {
    const { note } = req.body;
    const { rows } = await pool.query(
      `UPDATE returns SET note = $1, updated_at = now() WHERE id = $2 RETURNING id, note`,
      [note, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[/alertas/devolucoes/:id/note]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/alertas/devolucoes/:id/prejuizo', async (req, res) => {
  // Prejuízo é digitado manualmente pelo usuário (não vem da API do ML) —
  // string vazia ou não numérica grava NULL, não zero, pra distinguir
  // "não avaliado ainda" de "prejuízo de fato zero". Ver business-rules.md.
  try {
    const valor = req.body.prejuizo;
    const prejuizo = valor === '' || valor === null || valor === undefined || Number.isNaN(Number(valor)) ? null : Number(valor);
    const { rows } = await pool.query(
      `UPDATE returns SET prejuizo = $1, updated_at = now() WHERE id = $2 RETURNING id, prejuizo`,
      [prejuizo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[/alertas/devolucoes/:id/prejuizo]', e.message);
    res.status(500).json({ error: e.message });
  }
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
       LEFT JOIN vw_ml_items i ON i.ml_id = ic.item_id
       LEFT JOIN vw_ml_stores s ON s.id = ic.store_id
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
  try {
    const { store_id = '', level = '', sort = 'score_asc' } = req.query;
    const storeFilter = store_id ? `AND i.store_id = ${BigInt(store_id)}` : '';
    const levelFilter = level ? `AND LOWER(p.level) = LOWER('${level.replace(/'/g,'')}')` : '';

    const orderBy = sort === 'score_desc' ? 'p.score DESC NULLS LAST'
      : sort === 'title' ? 'i.title ASC'
      : 'p.score ASC NULLS LAST';

    const { rows } = await pool.query(
      `SELECT i.ml_id, i.store_id, s.nickname as store_name,
              i.title, i.price, i.available_quantity, i.status,
              COALESCE(o.pedidos_30d, 0) as pedidos_30d,
              COALESCE(o.pedidos_15d, 0) as pedidos_15d,
              COALESCE(o.pedidos_7d,  0) as pedidos_7d,
              COALESCE(o.receita_30d, 0) as receita_30d,
              COALESCE(o.receita_7d,  0) as receita_7d,
              p.score, p.level, p.level_wording, p.pending_count,
              p.buckets, p.synced_at
       FROM vw_ml_items i
       JOIN vw_ml_stores s ON s.id = i.store_id
       LEFT JOIN (
         SELECT item_id,
           COUNT(*) FILTER (WHERE date_created >= CURRENT_DATE - 30) pedidos_30d,
           COUNT(*) FILTER (WHERE date_created >= CURRENT_DATE - 15) pedidos_15d,
           COUNT(*) FILTER (WHERE date_created >= CURRENT_DATE - 7)  pedidos_7d,
           COALESCE(SUM(total_amount) FILTER (WHERE date_created >= CURRENT_DATE - 30),0) receita_30d,
           COALESCE(SUM(total_amount) FILTER (WHERE date_created >= CURRENT_DATE - 7),0)  receita_7d
         FROM vw_ml_orders
         WHERE status != 'cancelled'
         GROUP BY item_id
       ) o ON o.item_id = i.ml_id
       LEFT JOIN item_performance p ON p.item_id = i.ml_id
       WHERE i.status = 'active' ${storeFilter} ${levelFilter}
       ORDER BY ${orderBy}
       LIMIT 300`
    );

    // KPI summary
    const total = rows.length;
    const withScore = rows.filter(r => r.score !== null);
    const avgScore = withScore.length
      ? Math.round(withScore.reduce((a, r) => a + Number(r.score), 0) / withScore.length)
      : null;
    const summary = {
      total,
      synced: withScore.length,
      basico:       rows.filter(r => r.level === 'Bad').length,
      satisfatorio: rows.filter(r => r.level === 'Medium').length,
      profissional: rows.filter(r => r.level === 'Good').length,
      sem_score:    rows.filter(r => r.score === null).length,
      avg_score:    avgScore,
      last_sync:    withScore.length ? rows.filter(r => r.synced_at).sort((a,b) => new Date(b.synced_at)-new Date(a.synced_at))[0]?.synced_at : null,
    };

    res.json({ items: rows, summary });
  } catch(e) {
    console.error('[anuncios-problema]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Qualidade de Anúncio (SEO Score próprio) — ver seoScore.js/decisions.md.
// Score é dado calculado pelo sistema (fórmula, nunca IA); pictures_count/
// has_gtin/etc. são dado oficial da API do ML — nunca sobrescritos pelo score.
router.get('/qualidade-anuncio', async (req, res) => {
  try {
    const { store_id = '', category_id = '', brand = '', is_full = '', catalog_listing = '', shipping_type = '', sort = 'score_asc' } = req.query;
    const where = [];
    const params = [];
    if (store_id)       { params.push(store_id); where.push(`q.store_id = $${params.length}::bigint`); }
    if (category_id)    { params.push(category_id); where.push(`q.category_id = $${params.length}`); }
    if (brand)          { params.push(`%${brand}%`); where.push(`q.brand ILIKE $${params.length}`); }
    if (is_full === 'true' || is_full === 'false')                 { params.push(is_full === 'true'); where.push(`q.is_full = $${params.length}`); }
    if (catalog_listing === 'true' || catalog_listing === 'false') { params.push(catalog_listing === 'true'); where.push(`q.catalog_listing = $${params.length}`); }
    if (shipping_type)  { params.push(shipping_type); where.push(`q.shipping_type = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const orderBy = sort === 'score_desc' ? 'q.score DESC NULLS LAST'
      : sort === 'title' ? 'i.title ASC'
      : 'q.score ASC NULLS LAST';

    const { rows } = await pool.query(
      `SELECT q.item_id, q.store_id, s.nickname AS store_name, i.title, i.thumbnail, i.permalink,
              q.category_id, q.brand, q.pictures_count, q.has_video, q.title_length, q.description_word_count,
              q.has_gtin, q.has_brand, q.has_model, q.is_full, q.shipping_type, q.catalog_listing,
              q.required_attrs_total, q.required_attrs_missing, q.missing_required_attrs,
              q.visits_30d, q.sales_30d, q.conversion_rate,
              q.photos_score, q.video_score, q.title_score, q.description_score,
              q.gtin_score, q.brand_score, q.model_score, q.full_score, q.catalog_score,
              q.attributes_score, q.conversion_score, q.visits_score, q.score, q.calculated_at,
              cc.status AS buybox_status, cc.price_to_win, cc.winner_item_id, cc.winner_price,
              cc.boosts_missing AS buybox_boosts_missing, cc.calculated_at AS buybox_calculated_at
       FROM item_seo_score q
       JOIN items i ON i.ml_id = q.item_id
       LEFT JOIN stores s ON s.id = q.store_id
       LEFT JOIN catalog_competition cc ON cc.item_id = q.item_id
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT 500`,
      params
    );

    const withScore = rows.filter(r => r.score !== null);
    const avgScore = withScore.length
      ? Math.round((withScore.reduce((a, r) => a + Number(r.score), 0) / withScore.length) * 100) / 100
      : null;
    // "Ganhando" é decidido comparando winner_item_id ao próprio item, não pela
    // string de status (só um valor foi confirmado ao vivo — ver decisions.md).
    const summary = {
      total: rows.length,
      synced: withScore.length,
      avg_score: avgScore,
      sem_gtin: rows.filter(r => !r.has_gtin).length,
      sem_video: rows.filter(r => !r.has_video).length,
      sem_catalogo: rows.filter(r => !r.catalog_listing).length,
      atributos_incompletos: rows.filter(r => (r.required_attrs_missing || 0) > 0).length,
      full: rows.filter(r => r.is_full).length,
      nao_full: rows.filter(r => !r.is_full).length,
      perdendo_buybox: rows.filter(r => r.catalog_listing && r.winner_item_id && r.winner_item_id !== r.item_id).length,
    };

    res.json({ items: rows, summary });
  } catch (e) {
    console.error('[qualidade-anuncio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Evolução do SEO Score médio da frota filtrada (dashboard, gráfico de linha) —
// mesmos filtros da listagem principal + período. Junta com item_seo_score
// pra aplicar loja/categoria/marca/etc ao histórico (atributos que raramente
// mudam, então aplicar o filtro "de hoje" ao histórico é uma simplificação aceitável).
router.get('/qualidade-anuncio/historico-medio', async (req, res) => {
  try {
    const { days = 30, store_id = '', category_id = '', brand = '', is_full = '', catalog_listing = '', shipping_type = '' } = req.query;
    const where = [`h.captured_at >= CURRENT_DATE - $1::int`];
    const params = [Math.min(Math.max(Number(days) || 30, 1), 180)];
    if (store_id)       { params.push(store_id); where.push(`q.store_id = $${params.length}::bigint`); }
    if (category_id)    { params.push(category_id); where.push(`q.category_id = $${params.length}`); }
    if (brand)          { params.push(`%${brand}%`); where.push(`q.brand ILIKE $${params.length}`); }
    if (is_full === 'true' || is_full === 'false')                 { params.push(is_full === 'true'); where.push(`q.is_full = $${params.length}`); }
    if (catalog_listing === 'true' || catalog_listing === 'false') { params.push(catalog_listing === 'true'); where.push(`q.catalog_listing = $${params.length}`); }
    if (shipping_type)  { params.push(shipping_type); where.push(`q.shipping_type = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT h.captured_at::date AS date, AVG(h.score)::numeric(5,2) AS avg_score, COUNT(DISTINCT h.item_id)::int AS items
       FROM item_seo_score_history h
       JOIN item_seo_score q ON q.item_id = h.item_id
       WHERE ${where.join(' AND ')}
       GROUP BY h.captured_at::date
       ORDER BY h.captured_at::date`,
      params
    );
    res.json({ days: rows });
  } catch (e) {
    console.error('[qualidade-anuncio/historico-medio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Evolução do SEO Score de um item específico (gráfico de linha).
router.get('/qualidade-anuncio/:itemId/historico', async (req, res) => {
  try {
    const { date_from = '', date_to = '' } = req.query;
    const where = ['item_id = $1'];
    const params = [req.params.itemId];
    if (date_from) { params.push(date_from); where.push(`captured_at >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   where.push(`captured_at <= $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT score, captured_at FROM item_seo_score_history WHERE ${where.join(' AND ')} ORDER BY captured_at ASC`,
      params
    );
    res.json({ history: rows });
  } catch (e) {
    console.error('[qualidade-anuncio/historico]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Lista de concorrentes do mesmo produto de catálogo — SOB DEMANDA (chama a API
// do ML em tempo real, exceção documentada à regra 3 de architecture.md, mesmo
// padrão já usado em GET /api/items/:item_id/promotion). Não é buscada no job
// diário pra não gastar 1 chamada extra/item/dia em itens que ninguém vai abrir.
router.get('/qualidade-anuncio/:itemId/concorrentes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT store_id, catalog_product_id, winner_item_id FROM catalog_competition WHERE item_id = $1`,
      [req.params.itemId]
    );
    if (!rows.length || !rows[0].catalog_product_id) {
      return res.json({ competitors: [], message: 'Sem dado de concorrência sincronizado pra este item ainda.' });
    }
    const { store_id, catalog_product_id, winner_item_id } = rows[0];

    const ml = require('../mlClient');
    const result = await ml.getCatalogCompetitors(catalog_product_id, store_id);
    const competitors = (result.results || [])
      .map(r => ({
        item_id: r.item_id,
        seller_id: r.seller_id,
        price: r.price,
        logistic_type: r.shipping?.logistic_type || null,
        free_shipping: !!r.shipping?.free_shipping,
        is_you: r.item_id === req.params.itemId,
        is_winner: r.item_id === winner_item_id,
      }))
      .sort((a, b) => a.price - b.price);

    res.json({ competitors, total: result.paging?.total ?? competitors.length });
  } catch (e) {
    console.error('[qualidade-anuncio/concorrentes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sync performance scores — chama /item/{id}/performance no ML ──────────
let perfSyncRunning = false;
router.post('/alertas/anuncios-performance/sync', async (req, res) => {
  if (perfSyncRunning) return res.json({ status: 'already_running' });

  const { store_id = '', limit = 50 } = req.body || {};
  const storeFilter = store_id ? `AND store_id = ${BigInt(store_id)}` : '';

  // Items sem score ou com score > 24h desatualizado têm prioridade
  const { rows: items } = await pool.query(
    `SELECT i.ml_id, i.store_id FROM vw_ml_items i
     LEFT JOIN item_performance p ON p.item_id = i.ml_id
     WHERE i.status = 'active' ${storeFilter}
       AND (p.item_id IS NULL OR p.synced_at < now() - interval '24 hours')
     ORDER BY p.synced_at ASC NULLS FIRST
     LIMIT $1`,
    [Number(limit)]
  );

  if (!items.length) return res.json({ status: 'nothing_to_sync', synced: 0 });

  res.json({ status: 'started', total: items.length });

  // Executa em background — não bloqueia a resposta HTTP
  perfSyncRunning = true;
  (async () => {
    const ml = require('../mlClient');
    let ok = 0, fail = 0;
    for (const item of items) {
      try {
        const data = await ml.get(`/item/${item.ml_id}/performance`, item.store_id);
        const pending = (data.buckets || []).flatMap(b => b.variables || []).filter(v => v.status === 'PENDING');
        await pool.query(
          `INSERT INTO item_performance(store_id, item_id, score, level, level_wording, pending_count, buckets, calculated_at, synced_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT(item_id) DO UPDATE SET
             score=$3, level=$4, level_wording=$5, pending_count=$6, buckets=$7,
             calculated_at=$8, synced_at=now()`,
          [item.store_id, item.ml_id, data.score, data.level, data.level_wording,
           pending.length, JSON.stringify(data.buckets || []), data.calculated_at]
        );
        ok++;
      } catch(e) {
        // 400 = item sem score no ML — não conta como erro, só pula
        if (!e.message?.includes('400')) fail++;
        if (e.message?.includes('429')) { await new Promise(r => setTimeout(r, 5000)); }
      }
      await new Promise(r => setTimeout(r, 300)); // 300ms entre chamadas
    }
    console.log(`[perf-sync] concluído: ${ok} ok, ${fail} erros`);
    perfSyncRunning = false;
  })().catch(() => { perfSyncRunning = false; });
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
         FROM vw_ml_orders o
         LEFT JOIN vw_ml_items it ON it.ml_id = o.item_id
         WHERE o.status != 'cancelled'
           AND o.date_created >= CURRENT_DATE - $1::int
           AND ($2 = '' OR o.store_id = $2::bigint)
         GROUP BY 1
       ),
       visit_agg AS (
         SELECT COALESCE(it.parent_item_id, iv.item_id) AS root_id,
                SUM(iv.visits) AS visitas
         FROM item_visits iv
         LEFT JOIN vw_ml_items it ON it.ml_id = iv.item_id
         WHERE iv.date >= CURRENT_DATE - $1::int
           AND ($2 = '' OR iv.store_id = $2::bigint)
         GROUP BY 1
       ),
       item_repr AS (
         SELECT DISTINCT ON (COALESCE(parent_item_id, ml_id))
           ml_id, title, price, available_quantity, sold_quantity, status,
           thumbnail, permalink,
           COALESCE(parent_item_id, ml_id) AS group_key
         FROM vw_ml_items
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
    const { date_from, date_to } = req.query;
    // Range explícito (De/Até) tem prioridade sobre `days` — quando informado,
    // a comparação "vs Mês Anterior" desloca a mesma janela 30 dias pra trás
    // (mesma semântica já usada no modo `days`, generalizada pra qualquer
    // range: não é período-sobre-período de tamanho igual, é sempre "mesma
    // data(s), 1 mês antes" — ver business-rules.md).
    if (date_from && date_to) {
      const dateToEnd = `${date_to} 23:59:59`;
      const [{ rows: current }, { rows: previous }] = await Promise.all([
        pool.query(`
          SELECT o.store_id, s.nickname as loja, (o.date_created - INTERVAL '3 hours')::date AS dia,
                 COUNT(*) as pedidos, SUM(o.total_amount) as receita
          FROM vw_ml_orders o
          JOIN vw_ml_stores s ON s.id = o.store_id
          WHERE o.date_created >= $1::timestamptz AND o.date_created <= $2::timestamptz
            AND o.status != 'cancelled'
          GROUP BY 1, 2, 3
          ORDER BY 3, 2
        `, [date_from, dateToEnd]),
        pool.query(`
          SELECT o.store_id, (o.date_created - INTERVAL '3 hours')::date AS dia, SUM(o.total_amount) as receita
          FROM vw_ml_orders o
          WHERE o.date_created >= ($1::timestamptz - interval '30 days')
            AND o.date_created <= ($2::timestamptz - interval '30 days')
            AND o.status != 'cancelled'
          GROUP BY 1, 2
        `, [date_from, dateToEnd]),
      ]);
      return res.json({ current, previous });
    }

    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const { rows: current } = await pool.query(`
      SELECT
        o.store_id,
        s.nickname as loja,
        (o.date_created - INTERVAL '3 hours')::date AS dia,
        COUNT(*) as pedidos,
        SUM(o.total_amount) as receita
      FROM vw_ml_orders o
      JOIN vw_ml_stores s ON s.id = o.store_id
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
      FROM vw_ml_orders o
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
      `SELECT COALESCE(parent_item_id, ml_id) AS root_id, store_id FROM vw_ml_items WHERE ml_id = $1 LIMIT 1`, [id]
    );
    const rootId  = itemRow[0]?.root_id  || id;
    const storeId = itemRow[0]?.store_id || null;

    // Visitas por dia para o item (e suas variações)
    const { rows: visitas } = await pool.query(
      `SELECT iv.date, SUM(iv.visits) AS visitas
       FROM item_visits iv
       LEFT JOIN vw_ml_items it ON it.ml_id = iv.item_id
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
       FROM vw_ml_orders o
       LEFT JOIN vw_ml_items it ON it.ml_id = o.item_id
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

// ── Publicidade ──────────────────────────────────────────────────────────────
router.get('/publicidade', async (req, res) => {
  try {
    const { rows: stores } = await pool.query('SELECT id, nickname FROM vw_ml_stores');
    const ml = require('../mlClient');
    const endpoints = [
      `/advertising/product_ads/campaigns?status=active&limit=10`,
      `/advertising/v2/campaigns?limit=10`,
      `/products/promotions?seller_id=SELLER_ID&limit=10`,
    ];
    const results = [];
    for (const store of stores) {
      const storeResult = { store: store.nickname, store_id: store.id, tests: [] };
      for (const ep of endpoints) {
        const url = ep.replace('SELLER_ID', store.id);
        try {
          const data = await ml.get(url, store.id);
          storeResult.tests.push({ url, status: 'ok', data });
          break; // parar no primeiro que funcionar
        } catch (e) {
          storeResult.tests.push({ url, status: 'error', error: e.message });
        }
      }
      results.push(storeResult);
    }
    res.json({ stores: results, raw: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MCP Chat — Assistente de Vendas ────────────────────────────────────────
router.post('/mcp/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor. Adicione ao .env e reinicie.' });

  const { message, store_id } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Campo message obrigatório.' });

  try {
    const storeFilter = store_id ? `AND store_id = ${BigInt(store_id)}` : '';
    const tz = `AT TIME ZONE 'America/Sao_Paulo'`;

    // Coleta dados relevantes em paralelo
    const [kpisR, topR, pendingR, lowR, cancelR, storesR] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE (date_created ${tz})::date = (now() ${tz})::date) pedidos_hoje,
          COALESCE(SUM(total_amount) FILTER (WHERE (date_created ${tz})::date = (now() ${tz})::date),0) receita_hoje,
          COUNT(*) FILTER (WHERE status='ready_to_ship') aguardando_envio,
          COUNT(*) FILTER (WHERE status='paid') pagos,
          COUNT(*) FILTER (WHERE status='shipped') enviados,
          COUNT(*) FILTER (WHERE (date_created ${tz})::date >= (now() ${tz})::date - 7) pedidos_7d,
          COALESCE(SUM(total_amount) FILTER (WHERE (date_created ${tz})::date >= (now() ${tz})::date - 7),0) receita_7d,
          COUNT(*) FILTER (WHERE (date_created ${tz})::date >= (now() ${tz})::date - 30) pedidos_30d,
          COALESCE(SUM(total_amount) FILTER (WHERE (date_created ${tz})::date >= (now() ${tz})::date - 30),0) receita_30d
        FROM vw_ml_orders WHERE status != 'cancelled' ${storeFilter}`),

      pool.query(`
        SELECT o.item_id, i.title, COUNT(*) vendas, SUM(o.total_amount) receita
        FROM vw_ml_orders o LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
        WHERE (o.date_created ${tz})::date >= (now() ${tz})::date - 30 AND o.status != 'cancelled' ${storeFilter}
        GROUP BY o.item_id, i.title ORDER BY vendas DESC LIMIT 10`),

      pool.query(`SELECT COUNT(*) n FROM questions WHERE status='UNANSWERED'`),

      pool.query(`SELECT title, available_quantity FROM vw_ml_items WHERE available_quantity <= 5 AND status='active' ${storeFilter} ORDER BY available_quantity LIMIT 10`),

      pool.query(`
        SELECT o.item_id, i.title, COUNT(*) cancelamentos
        FROM vw_ml_orders o LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
        WHERE o.status='cancelled' AND (o.date_created ${tz})::date >= (now() ${tz})::date - 30 ${storeFilter}
        GROUP BY o.item_id, i.title ORDER BY cancelamentos DESC LIMIT 5`),

      pool.query(`SELECT nickname, token_valid FROM vw_ml_stores ORDER BY nickname`),
    ]);

    const ctx = {
      kpis: kpisR.rows[0],
      top_produtos: topR.rows,
      perguntas_pendentes: pendingR.rows[0].n,
      estoque_baixo: lowR.rows,
      cancelamentos: cancelR.rows,
      lojas: storesR.rows,
      data_hoje: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }),
    };

    const fetch = require('node-fetch');
    const mlRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Você é um assistente especialista em e-commerce Mercado Livre. Responda sempre em português brasileiro de forma direta e clara. Use os dados reais abaixo das lojas do usuário. Formate valores em R$ com vírgula brasileira. Hoje é ${ctx.data_hoje}.

DADOS ATUAIS DAS LOJAS:
${JSON.stringify(ctx, null, 2)}

Seja direto e objetivo. Use listas quando listar itens. Destaque números importantes com **negrito**. Se não souber algo específico que não está nos dados, diga que não tem esse detalhe disponível.`,
        messages: [{ role: 'user', content: message }],
      }),
    });

    const aiData = await mlRes.json();
    if (!mlRes.ok) throw new Error(aiData?.error?.message || `Anthropic API ${mlRes.status}`);

    const reply = aiData.content?.[0]?.text || 'Sem resposta.';
    res.json({ reply });
  } catch (e) {
    console.error('[MCP chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MCP Docs — Proxy para documentação oficial ML ──────────────────────────
router.post('/mcp/docs', async (req, res) => {
  const { query, language = 'pt_br', siteId = 'MLB', limit = 5 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Campo query obrigatório.' });

  // Busca via ML MCP oficial — requer token de alguma loja conectada
  try {
    const { rows } = await pool.query(`SELECT access_token FROM vw_ml_stores WHERE access_token IS NOT NULL LIMIT 1`);
    if (!rows.length) return res.status(503).json({ error: 'Nenhuma loja com token disponível.' });

    const fetch = require('node-fetch');
    const mlRes = await fetch('https://mcp.mercadolibre.com/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rows[0].access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'search_documentation',
          arguments: { query, language, siteId, limit },
        }
      }),
    });

    const data = await mlRes.json();
    if (!mlRes.ok) throw new Error(JSON.stringify(data));
    res.json(data.result || data);
  } catch (e) {
    console.error('[MCP docs]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Promoções de um item — consulta em tempo real na ML API ───────────────
router.get('/items/:item_id/promotion', async (req, res) => {
  const { item_id } = req.params;
  const { store_id } = req.query;
  if (!store_id) return res.status(400).json({ error: 'store_id obrigatório' });

  try {
    const ml = require('../mlClient');

    // 1. Busca dados completos do item (inclui deal_ids e campos de promoção)
    const item = await ml.get(`/items/${item_id}?include_attributes=all`, Number(store_id));

    console.log(`[promotion] ${item_id} price=${item.price} original=${item.original_price} sale_price=${JSON.stringify(item.sale_price)} deal_ids=${JSON.stringify(item.deal_ids)} promotions=${JSON.stringify(item.promotions)}`);

    const result = {
      item_id,
      in_promotion: false,
      promotions: [],
      deals: [],
      _debug: {
        price: item.price,
        original_price: item.original_price,
        sale_price: item.sale_price || null,
        deal_ids: item.deal_ids || [],
        promotions_field: item.promotions || null,
      },
    };

    // 1. sale_price object — promoção de preço ML (tipo mais comum para desconto %)
    if (item.sale_price && item.sale_price.type === 'promotion') {
      const sp = item.sale_price;
      const regularPrice = sp.regular_amount || item.original_price || item.price;
      const promoPrice   = sp.amount || item.price;
      result.in_promotion = true;
      result.promotions.push({
        id: sp.promotion_id || 'sale_price',
        name: sp.name || 'Promoção de preço',
        type: 'price_discount',
        status: 'active',
        discount_pct: regularPrice > promoPrice ? Math.round((1 - promoPrice / regularPrice) * 100) : null,
        original_price: regularPrice,
        promo_price: promoPrice,
        start_date: sp.start_time || null,
        end_date: sp.end_time || null,
      });
    }

    // 2. promotions array no item (pode vir junto com a resposta do item)
    for (const p of (Array.isArray(item.promotions) ? item.promotions : [])) {
      result.in_promotion = true;
      result.promotions.push({
        id: p.id || p.promotion_id,
        name: p.name || p.type || 'Promoção',
        type: p.type || 'promotion',
        status: p.status || 'active',
        discount_pct: p.discount_percentage || null,
        original_price: p.original_price || null,
        promo_price: p.price || null,
        start_date: p.start_date || null,
        end_date: p.end_date || p.finish_time || null,
      });
    }

    // 3. original_price > price — desconto direto no item
    if (item.original_price && item.original_price > item.price) {
      result.has_discount = true;
      result.discount_pct = Math.round((1 - item.price / item.original_price) * 100);
      result.original_price = item.original_price;
      result.current_price  = item.price;
      result.in_promotion   = true;
    }

    // 4. Endpoint direto /items/{id}/promotions
    try {
      const directPromos = await ml.get(`/items/${item_id}/promotions`, Number(store_id));
      const promoArr = Array.isArray(directPromos) ? directPromos : (directPromos.results || []);
      for (const p of promoArr) {
        if (!result.promotions.find(x => String(x.id) === String(p.id || p.promotion_id))) {
          result.in_promotion = true;
          result.promotions.push({
            id: p.id || p.promotion_id,
            name: p.name || p.type || 'Promoção',
            type: p.type || 'promotion',
            status: p.status || 'active',
            discount_pct: p.discount_percentage || null,
            original_price: p.original_price || null,
            promo_price: p.price || null,
            start_date: p.start_date || null,
            end_date: p.end_date || p.finish_time || null,
          });
        }
      }
    } catch {}

    // 5. deal_ids → busca detalhes de cada deal
    const dealIds = item.deal_ids || [];
    for (const dealId of dealIds.slice(0, 5)) {
      try {
        const deal = await ml.get(`/items/${item_id}/deals/${dealId}`, Number(store_id));
        result.deals.push({
          id: dealId,
          type: deal.type || deal.promotion_type || 'deal',
          discount_pct: deal.discount_percentage || deal.discount || null,
          original_price: deal.original_price || item.original_price || null,
          price: deal.price || item.price || null,
          start_date: deal.start_date || null,
          end_date: deal.end_date || deal.finish_time || null,
          status: deal.status || 'active',
        });
        result.in_promotion = true;
      } catch {}
    }

    // 6. seller-promotions API (listagem paginada por loja)
    try {
      const { rows: storeRows } = await require('../db/pool').query(
        'SELECT id FROM vw_ml_stores WHERE id = $1', [Number(store_id)]
      );
      const uid = storeRows[0]?.id;
      if (uid) {
        const promoList = await ml.get(
          `/seller-promotions/users/${uid}/promotions?status=started&offset=0&limit=20`,
          Number(store_id)
        );
        const promos = Array.isArray(promoList) ? promoList : (promoList.results || []);
        for (const promo of promos) {
          try {
            const promoItems = await ml.get(
              `/seller-promotions/${promo.id}/items?offset=0&limit=100`,
              Number(store_id)
            );
            const found = (Array.isArray(promoItems) ? promoItems : promoItems.results || [])
              .find(pi => pi.id === item_id || pi.item_id === item_id);
            if (found && !result.promotions.find(x => String(x.id) === String(promo.id))) {
              result.promotions.push({
                id: promo.id,
                name: promo.name || promo.type || 'Promoção',
                type: promo.type,
                status: promo.status,
                discount_pct: found.discount_percentage || promo.discount_percentage || null,
                original_price: found.original_price || null,
                promo_price: found.price || null,
                start_date: promo.start_date || null,
                end_date: promo.finish_time || promo.end_date || null,
              });
              result.in_promotion = true;
            }
          } catch {}
        }
      }
    } catch {}

    res.json(result);
  } catch (e) {
    console.error('[promotion]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Conciliação Bancária ───────────────────────────────────
// Agenda de Recebimentos: agrupa pagamentos ainda não liberados por dia de
// money_release_date (cast pra date — o valor cru tem hora, agrupar pela
// timestamp completa nunca juntaria pagamentos diferentes no mesmo dia).
// Devolve granularidade diária; "hoje/amanhã/7 dias/30 dias" é agregação
// no cliente sobre essa lista, não pré-calculado aqui — evita fixar um
// formato de bucket antes de existir página consumindo isso de verdade.
// Resumo por loja — total a receber (não liberado), pra não misturar tudo
// numa conta só quando há mais de uma loja (pedido explícito do usuário).
router.get('/conciliacao/resumo-lojas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS store_id, s.nickname,
              COALESCE(SUM(p.net_received_amount), 0) AS valor_liquido,
              COUNT(p.payment_id) AS qtd_pagamentos
       FROM stores s
       LEFT JOIN ml_payments p ON p.store_id = s.id AND p.released IS DISTINCT FROM 'yes'
       WHERE s.marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR s.marketplace_id IS NULL
       GROUP BY s.id, s.nickname
       HAVING COUNT(p.payment_id) > 0
       ORDER BY valor_liquido DESC`
    );
    res.json({
      lojas: rows.map(r => ({
        store_id: r.store_id,
        nickname: r.nickname,
        valor_liquido: Number(r.valor_liquido),
        qtd_pagamentos: Number(r.qtd_pagamentos),
      })),
    });
  } catch (e) {
    console.error('[conciliacao/resumo-lojas] erro:', e.message);
    res.status(500).json({ error: e.message, lojas: [] });
  }
});

router.get('/conciliacao/agenda-recebimentos', async (req, res) => {
  try {
    const { store_id = '' } = req.query;
    const { rows } = await pool.query(
      `SELECT
         (money_release_date AT TIME ZONE 'America/Sao_Paulo')::date AS data,
         COUNT(*) AS qtd_pagamentos,
         COALESCE(SUM(net_received_amount), 0) AS valor_liquido,
         COALESCE(SUM(transaction_amount), 0) AS valor_bruto
       FROM ml_payments
       WHERE released IS DISTINCT FROM 'yes'
         AND money_release_date IS NOT NULL
         AND ($1 = '' OR store_id = $1::bigint)
       GROUP BY 1
       ORDER BY 1`,
      [store_id]
    );
    res.json({
      dias: rows.map(r => ({
        data: r.data,
        qtd_pagamentos: Number(r.qtd_pagamentos),
        valor_liquido: Number(r.valor_liquido),
        valor_bruto: Number(r.valor_bruto),
      })),
    });
  } catch (e) {
    console.error('[conciliacao/agenda-recebimentos] erro:', e.message);
    res.status(500).json({ error: e.message, dias: [] });
  }
});

// Grid principal — listagem paginada de pagamentos individuais. `orders`/`stores`
// direto (não `vw_ml_*`) porque `ml_payments` só é populada pelo pipeline ML
// hoje (handlePayment), então o JOIN já é implicitamente ML-only — mas os
// filtros abaixo funcionam do mesmo jeito se isso mudar no futuro.
const CONCILIACAO_SORT_COLS = {
  data: 'p.date_approved',
  valor: 'p.transaction_amount',
  liquido: 'p.net_received_amount',
  status: 'p.status',
  diferenca: '(p.transaction_amount - COALESCE(p.net_received_amount, p.transaction_amount))',
  liberacao: 'p.money_release_date',
  entrega: 'o.shipping_status',
};
// Bucket de UI → status crus retornados por /shipments/:id (ver business-rules.md
// pro mapeamento completo com emoji/cor — mesma tabela é replicada no frontend,
// já que não há runtime compartilhado entre página estática e Node aqui).
const SHIPPING_STATUS_BUCKETS = {
  aguardando: ['pending'],
  preparando: ['handling', 'ready_to_ship'],
  transito: ['shipped'],
  entregue: ['delivered'],
  cancelado: ['cancelled'],
  nao_entregue: ['not_delivered'],
};
// Bucket de UI → padrões ILIKE de orders.shipping_type (mesmo mapeamento por
// substring de fmtLogistica em worker.js — shipping_type não tem um conjunto
// fechado de valores exatos, então filtra por trecho, não igualdade).
const LOGISTICA_BUCKETS = {
  full: ['%fulfillment%'],
  flex: ['%self_service%', '%flex%'],
  me: ['%xd_drop_off%', '%me2%', '%me1%', '%cross_docking%'],
  coleta: ['%pickup%'],
};
router.get('/conciliacao/pagamentos', async (req, res) => {
  try {
    const {
      store_id = '', released = '', date_from = '', date_to = '', q = '', entrega = '', logistica = '',
      release_from = '', release_to = '',
      sort = 'data', dir = 'desc', page = '1', limit = '50',
    } = req.query;

    const sortCol = CONCILIACAO_SORT_COLS[sort] || CONCILIACAO_SORT_COLS.data;
    const sortDir = dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const entregaStatuses = SHIPPING_STATUS_BUCKETS[entrega] || null;
    const logisticaPatterns = LOGISTICA_BUCKETS[logistica] || null;
    // release_from/release_to filtram por money_release_date no fuso São Paulo
    // (mesmo cast da Agenda de Recebimentos) — usado pelo drill-down dos cards
    // "Recebo Hoje/Amanhã/..." pra listar as vendas que caem naquele dia.
    const params = [store_id, released, date_from || null, date_to || null, q, entregaStatuses, logisticaPatterns, release_from || null, release_to || null];
    const where = `
      WHERE ($1 = '' OR p.store_id = $1::bigint)
        AND ($2 = '' OR p.released = $2)
        AND ($3::date IS NULL OR p.date_approved::date >= $3::date)
        AND ($4::date IS NULL OR p.date_approved::date <= $4::date)
        AND ($5 = '' OR p.order_id ILIKE '%'||$5||'%' OR p.payment_id::text ILIKE '%'||$5||'%' OR o.buyer_nickname ILIKE '%'||$5||'%')
        AND ($6::text[] IS NULL OR o.shipping_status = ANY($6::text[]))
        AND ($7::text[] IS NULL OR o.shipping_type ILIKE ANY($7::text[]))
        AND ($8::date IS NULL OR (p.money_release_date AT TIME ZONE 'America/Sao_Paulo')::date >= $8::date)
        AND ($9::date IS NULL OR (p.money_release_date AT TIME ZONE 'America/Sao_Paulo')::date <= $9::date)`;

    const { rows } = await pool.query(
      `SELECT
         p.payment_id, p.order_id, p.store_id, s.nickname AS store_nickname,
         o.buyer_nickname, o.title,
         p.status, p.status_detail,
         p.date_approved, p.money_release_date, p.released,
         p.transaction_amount, p.net_received_amount, p.shipping_cost,
         (COALESCE(p.marketplace_fee,0) + COALESCE(p.mercadopago_fee,0) + COALESCE(p.discount_fee,0) + COALESCE(p.coupon_fee,0) + COALESCE(p.finance_fee,0)) AS taxas,
         (p.transaction_amount - COALESCE(p.net_received_amount, p.transaction_amount)) AS diferenca,
         p.payment_method_id, p.payment_type, p.installments, p.amount_refunded,
         o.shipping_status, o.shipping_substatus, o.date_ready_to_ship, o.date_shipped, o.date_delivered, o.shipping_last_updated,
         o.shipping_type
       FROM ml_payments p
       LEFT JOIN orders o ON o.ml_id = p.order_id
       LEFT JOIN stores s ON s.id = p.store_id
       ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $10 OFFSET $11`,
      [...params, limitNum, offset]
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total
       FROM ml_payments p
       LEFT JOIN orders o ON o.ml_id = p.order_id
       ${where}`,
      params
    );

    res.json({
      payments: rows,
      total: Number(countRows[0].total),
      page: pageNum,
      limit: limitNum,
    });
  } catch (e) {
    console.error('[conciliacao/pagamentos] erro:', e.message);
    res.status(500).json({ error: e.message, payments: [], total: 0 });
  }
});

// Detalhe de 1 pagamento (modal da grid) — todo campo já sincronizado,
// incluindo raw_data (payload bruto de /collections/:id) pra auditoria.
router.get('/conciliacao/pagamentos/:paymentId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, o.buyer_nickname, o.title, o.total_amount AS order_total_amount, o.item_id,
              o.date_created AS order_date_created, o.status AS order_status, o.shipping_type,
              o.shipping_status, o.shipping_substatus, o.date_ready_to_ship, o.date_shipped,
              o.date_delivered, o.shipping_last_updated,
              s.nickname AS store_nickname
       FROM ml_payments p
       LEFT JOIN orders o ON o.ml_id = p.order_id
       LEFT JOIN stores s ON s.id = p.store_id
       WHERE p.payment_id = $1`,
      [req.params.paymentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'pagamento não encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[conciliacao/pagamentos/:id] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reprocessar sob demanda — ação pontual explícita (botão "🔄 Reprocessar" no
// modal), não leitura de listagem, mesmo padrão já usado por "responder
// pergunta" nesta rota (ver architecture.md regra 2). Refaz o mesmo UPDATE que
// syncPaymentReleases faz em lote (pagamento) E o de syncShippingStatus
// (entrega), só que sob demanda pra 1 pedido — útil quando o usuário não quer
// esperar os jobs agendados, e como é 1 pedido só (não 200) não esbarra no
// rate limit em lote que o "Sincronizar Entregas" pode encontrar em horário
// de pico.
router.post('/conciliacao/pagamentos/:paymentId/reprocessar', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      `SELECT p.store_id, p.order_id, o.shipping_id
       FROM ml_payments p LEFT JOIN orders o ON o.ml_id = p.order_id
       WHERE p.payment_id=$1`,
      [req.params.paymentId]
    );
    if (!existing.length) return res.status(404).json({ error: 'pagamento não encontrado' });
    const { store_id, order_id, shipping_id } = existing[0];

    const ml = require('../mlClient');
    const payment = await ml.getPayment(req.params.paymentId, store_id);
    const c = payment?.collection || payment;
    await pool.query(
      `UPDATE ml_payments SET
         status=$2, status_detail=$3, net_received_amount=$4, money_release_date=$5,
         released=$6, marketplace_fee=$7, mercadopago_fee=$8, discount_fee=$9,
         coupon_fee=$10, finance_fee=$11, amount_refunded=$12, shipping_cost=$13,
         payment_method_id=$14, payment_type=$15, installments=$16, raw_data=$17, updated_at=now()
       WHERE payment_id=$1`,
      [
        req.params.paymentId, c?.status || null, c?.status_detail || null,
        c?.net_received_amount ?? null, c?.money_release_date || null, c?.released ?? null,
        c?.marketplace_fee ?? null, c?.mercadopago_fee ?? null, c?.discount_fee ?? null,
        c?.coupon_fee ?? null, c?.finance_fee ?? null, c?.amount_refunded ?? null,
        c?.shipping_cost ?? null, c?.payment_method_id || null, c?.payment_type || null,
        c?.installments ?? null, JSON.stringify(payment),
      ]
    );

    // Também atualiza o status de entrega desse pedido (se tiver shipping_id).
    // Em try/catch isolado: se o shipment falhar (ex: 429), o reprocesso do
    // pagamento acima já foi persistido — devolve `shipping_error` pro modal.
    let shippingError = null;
    if (order_id && shipping_id) {
      try {
        const ship = await ml.getShipment(shipping_id, store_id);
        const sh = ship?.status_history || {};
        await pool.query(
          `UPDATE orders SET
             shipping_status=$2, shipping_substatus=$3, date_ready_to_ship=$4,
             date_shipped=$5, date_delivered=$6, shipping_last_updated=$7, updated_at=now()
           WHERE ml_id=$1`,
          [
            order_id, ship?.status || null, ship?.substatus || null,
            sh.date_ready_to_ship || null, sh.date_shipped || null, sh.date_delivered || null,
            ship?.last_updated || null,
          ]
        );
      } catch (e) {
        shippingError = e.message;
        console.warn(`[conciliacao/reprocessar] shipment ${shipping_id} falhou: ${e.message}`);
      }
    }
    res.json({ ok: true, shipping_error: shippingError });
  } catch (e) {
    console.error('[conciliacao/pagamentos/:id/reprocessar] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Conciliação fase 2 — Relatórios de Liberação do Mercado Pago ──
// Todas leem só mp_account_movements (populada pelo job mp-reports). Ver
// conciliacao-bancaria.md / workers.md.

// Extrato da conta — cada crédito/débito, paginado.
router.get('/conciliacao/extrato', async (req, res) => {
  try {
    const { store_id = '', date_from = '', date_to = '', tipo = '', q = '', page = '1', limit = '50' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;
    const params = [store_id, date_from || null, date_to || null, tipo, q];
    const where = `
      WHERE ($1 = '' OR m.store_id = $1::bigint)
        AND ($2::date IS NULL OR (m.release_date AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date)
        AND ($3::date IS NULL OR (m.release_date AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date)
        AND ($4 = '' OR m.description = $4)
        AND ($5 = '' OR m.source_id ILIKE '%'||$5||'%' OR m.order_id ILIKE '%'||$5||'%')
        AND m.record_type IS DISTINCT FROM 'Total'`;
    const { rows } = await pool.query(
      `SELECT m.release_date, m.source_id, m.order_id, m.record_type, m.description,
              m.net_credit_amount, m.net_debit_amount, m.balance, m.payment_method,
              m.sale_detail, s.nickname AS store_nickname
       FROM mp_account_movements m LEFT JOIN stores s ON s.id = m.store_id
       ${where} ORDER BY m.release_date DESC LIMIT $6 OFFSET $7`,
      [...params, limitNum, offset]
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) total FROM mp_account_movements m ${where}`, params);
    res.json({ movimentos: rows, total: Number(cnt[0].total), page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('[conciliacao/extrato] erro:', e.message);
    res.status(500).json({ error: e.message, movimentos: [], total: 0 });
  }
});

// Saques bancários — cada 'Cash withdrawal' (transferência pro banco).
router.get('/conciliacao/saques', async (req, res) => {
  try {
    const { store_id = '' } = req.query;
    const { rows } = await pool.query(
      `SELECT m.release_date, m.net_debit_amount AS valor, m.balance, m.store_id, s.nickname AS store_nickname
       FROM mp_account_movements m LEFT JOIN stores s ON s.id = m.store_id
       WHERE m.description = 'Cash withdrawal' AND ($1 = '' OR m.store_id = $1::bigint)
       ORDER BY m.release_date DESC LIMIT 200`,
      [store_id]
    );
    res.json({ saques: rows });
  } catch (e) {
    console.error('[conciliacao/saques] erro:', e.message);
    res.status(500).json({ error: e.message, saques: [] });
  }
});

// Conciliação automática — bate o líquido previsto (ml_payments) contra o que
// realmente foi creditado no extrato (soma dos movimentos 'Payment' daquele
// pagamento). Veredito: Conciliado / Diferença / Pendente.
router.get('/conciliacao/auto', async (req, res) => {
  try {
    const { store_id = '', verdict = '' } = req.query;
    const { rows } = await pool.query(
      `SELECT p.payment_id, p.order_id, p.store_id, s.nickname AS store_nickname,
              o.title, p.net_received_amount AS esperado, p.released, p.money_release_date,
              COALESCE(SUM(m.net_credit_amount) FILTER (WHERE m.description = 'Payment'), 0) AS recebido,
              COALESCE(SUM(m.net_debit_amount) FILTER (WHERE m.description IN ('Refund','Mediation','reserve_for_dispute','Cancel of mediation')), 0) AS debitado
       FROM ml_payments p
       LEFT JOIN mp_account_movements m
         ON m.source_id = p.payment_id::text AND m.store_id = p.store_id
       LEFT JOIN orders o ON o.ml_id = p.order_id
       LEFT JOIN stores s ON s.id = p.store_id
       WHERE ($1 = '' OR p.store_id = $1::bigint)
       GROUP BY p.payment_id, p.order_id, p.store_id, s.nickname, o.title,
                p.net_received_amount, p.released, p.money_release_date, p.date_approved
       ORDER BY p.date_approved DESC NULLS LAST
       LIMIT 2000`,
      [store_id]
    );
    // Veredito calculado em JS (mais legível que num CASE gigante)
    const TOL = 0.5;
    const enriched = rows.map(r => {
      const esperado = Number(r.esperado || 0);
      const recebido = Number(r.recebido || 0);
      const debitado = Number(r.debitado || 0);
      let v;
      if (recebido === 0 && debitado === 0) v = 'pendente';
      else if (debitado > recebido) v = 'estornado';
      else if (Math.abs(recebido - esperado) <= TOL) v = 'conciliado';
      else v = 'diferenca';
      return { ...r, esperado, recebido, debitado, delta: recebido - esperado, verdict: v };
    });
    const filtered = verdict ? enriched.filter(r => r.verdict === verdict) : enriched;
    const resumo = enriched.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});
    res.json({ pagamentos: filtered.slice(0, 500), resumo, total: enriched.length });
  } catch (e) {
    console.error('[conciliacao/auto] erro:', e.message);
    res.status(500).json({ error: e.message, pagamentos: [], resumo: {} });
  }
});

module.exports = router;
