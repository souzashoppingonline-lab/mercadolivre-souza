// Consultas de relatório compartilhadas entre o worker (Telegram/e-mail) e a
// API HTTP (páginas do dashboard) — única fonte de verdade por cálculo,
// nunca duplicar a mesma query em mais de um lugar.
const pool = require('./db/pool');
const { CONCILIACAO_TARIFA_LATERAL, buscarFreteMotoboy } = require('./vendaMargem');

async function getResumoDiarioData() {
  const { rows: porLoja } = await pool.query(`
    SELECT s.nickname, COUNT(*) AS pedidos,
           SUM(o.total_amount) AS receita,
           SUM(o.quantity)     AS itens
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    WHERE o.date_created::date = CURRENT_DATE - 1 AND o.status != 'cancelled'
    GROUP BY s.nickname ORDER BY receita DESC
  `);

  const { rows: porLog } = await pool.query(`
    SELECT COALESCE(NULLIF(o.shipping_type,''), 'Desconhecido') AS tipo,
           COUNT(*) AS pedidos
    FROM orders o
    WHERE o.date_created::date = CURRENT_DATE - 1 AND o.status != 'cancelled'
    GROUP BY 1 ORDER BY 2 DESC
  `);

  return { porLoja, porLog };
}

// Top itens mais vendidos numa janela de N horas — usado tanto pelo alerta
// Telegram de 4h (syncTopVendas) quanto pelo digest diário de 24h
// (emailDailyReports/GET /api/dashboard/top-vendas-dia). ML-only (vw_ml_*).
async function getTopVendas({ hours = 24, limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT o.item_id, o.title, s.nickname AS loja,
            SUM(o.quantity) AS unidades, SUM(o.total_amount) AS receita
     FROM vw_ml_orders o
     LEFT JOIN vw_ml_stores s ON s.id = o.store_id
     WHERE o.status != 'cancelled' AND o.item_id IS NOT NULL
       AND o.date_created >= now() - ($1 || ' hours')::interval
     GROUP BY o.item_id, o.title, s.nickname
     ORDER BY unidades DESC LIMIT $2`,
    [hours, limit]
  );
  return rows.map(r => ({
    item_id: r.item_id, title: r.title, loja: r.loja,
    unidades: Number(r.unidades), receita: Number(r.receita),
  }));
}

// Comparativo semanal (7 dias vs. 7 dias anteriores) + curva ABC top 10 —
// mesma fórmula de margem de GET /api/vendas/detalhado (ver finance.md).
async function getResumoSemanal() {
  const periodoQuery = (fromDays, toDays) => pool.query(`
    SELECT COUNT(*) AS pedidos,
           COALESCE(SUM(o.total_amount), 0) AS receita,
           COALESCE(SUM(
             o.total_amount
             - COALESCE(i.cost, 0) * o.quantity
             - o.total_amount * COALESCE(s.imposto_pct, 0) / 100
             - COALESCE(o.ml_fee, 0)
             - COALESCE(o.shipping_cost, 0)
             - COALESCE(o.shipping_seller_cost, 0)
           ), 0) AS margem
    FROM vw_ml_orders o
    JOIN vw_ml_stores s ON s.id = o.store_id
    LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
    WHERE o.status != 'cancelled'
      AND o.date_created >= now() - interval '${fromDays} days'
      AND o.date_created <  now() - interval '${toDays} days'
  `);

  const { rows: atualRows }    = await periodoQuery(7, 0);
  const { rows: anteriorRows } = await periodoQuery(14, 7);
  const atual    = atualRows[0]    || {};
  const anterior = anteriorRows[0] || {};

  const varPedidos = Number(anterior.pedidos) > 0 ? ((atual.pedidos - anterior.pedidos) / anterior.pedidos) * 100 : 0;
  const varReceita = Number(anterior.receita) > 0 ? ((atual.receita - anterior.receita) / anterior.receita) * 100 : 0;

  const { rows: porLoja } = await pool.query(`
    SELECT s.nickname, COUNT(*) AS pedidos, SUM(o.total_amount) AS receita
    FROM vw_ml_orders o JOIN vw_ml_stores s ON s.id = o.store_id
    WHERE o.status != 'cancelled' AND o.date_created >= now() - interval '7 days'
    GROUP BY s.nickname ORDER BY receita DESC
  `);

  // Mesma lógica de GET /api/comparativos/curva-abc (routes/api.js), 7 dias, top 10.
  const { rows: abcRows } = await pool.query(`
    SELECT iid AS item_id,
           COALESCE(MAX(o.title), MAX(i.title)) AS title,
           SUM(COALESCE(o.total_amount, 0)) AS faturamento
    FROM vw_ml_orders o
    CROSS JOIN LATERAL (SELECT COALESCE(o.item_id, o.raw_data->'order_items'->0->'item'->>'id') AS iid) ids
    LEFT JOIN vw_ml_items i ON i.ml_id = ids.iid AND i.store_id = o.store_id
    WHERE o.status != 'cancelled' AND o.date_created >= now() - interval '7 days'
    GROUP BY ids.iid
    HAVING SUM(COALESCE(o.total_amount, 0)) > 0
    ORDER BY faturamento DESC LIMIT 10
  `);
  const totalAbc = abcRows.reduce((a, r) => a + Number(r.faturamento), 0);
  let acumAbc = 0;
  const curvaAbc = abcRows.map(r => {
    acumAbc += Number(r.faturamento);
    const pct = totalAbc > 0 ? (acumAbc / totalAbc) * 100 : 0;
    return { item_id: r.item_id, title: r.title, faturamento: Number(r.faturamento), curva: pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C' };
  });

  const mcPct = Number(atual.receita) > 0 ? (Number(atual.margem) / Number(atual.receita)) * 100 : 0;

  return {
    atual: {
      pedidos: Number(atual.pedidos) || 0, receita: Number(atual.receita) || 0,
      margem: Number(atual.margem) || 0, mc_pct: Number(mcPct.toFixed(1)),
    },
    anterior: {
      pedidos: Number(anterior.pedidos) || 0, receita: Number(anterior.receita) || 0,
      margem: Number(anterior.margem) || 0,
    },
    variacao: { pedidos_pct: Number(varPedidos.toFixed(1)), receita_pct: Number(varReceita.toFixed(1)) },
    por_loja: porLoja.map(r => ({ nickname: r.nickname, pedidos: Number(r.pedidos), receita: Number(r.receita) })),
    curva_abc: curvaAbc,
  };
}

// Outliers estatísticos de ontem — compara a receita de ontem de cada loja ML
// com a média histórica do mesmo dia-do-mês (12 meses), mesma janela/limiar
// (±1.5 desvio-padrão) do gráfico "Análise de Vendas do Mês". Usado tanto
// pelo alerta Telegram diário (checkOutlierEstatistico) quanto pelo card
// "Alerta do Dia" (GET /api/dashboard/alertas-dia).
async function getOutliersOntem() {
  const ontem = new Date(Date.now() - 86400000);
  const diaDoMes = ontem.getDate();
  const inicioOntem = new Date(ontem.getFullYear(), ontem.getMonth(), ontem.getDate());
  const fimOntem = new Date(inicioOntem.getTime() + 86400000);
  const inicioHistorico = new Date(ontem.getFullYear(), ontem.getMonth() - 12, 1);

  const { rows: stores } = await pool.query(`SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`);

  const outliers = [];
  for (const store of stores) {
    const { rows: ontemRows } = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS receita FROM orders
       WHERE store_id = $1 AND status != 'cancelled' AND date_created >= $2 AND date_created < $3`,
      [store.id, inicioOntem, fimOntem]
    );
    const receitaOntem = Number(ontemRows[0]?.receita || 0);

    const { rows: histRows } = await pool.query(
      `SELECT AVG(receita) AS media, COALESCE(STDDEV_POP(receita), 0) AS desvio, COUNT(*) AS n
       FROM (
         SELECT date_created::date AS d, SUM(total_amount) AS receita
         FROM orders
         WHERE store_id = $1 AND status != 'cancelled'
           AND EXTRACT(DAY FROM date_created) = $2
           AND date_created >= $3 AND date_created < $4
         GROUP BY 1
       ) daily`,
      [store.id, diaDoMes, inicioHistorico, inicioOntem]
    );
    const h = histRows[0];
    const n = Number(h?.n || 0);
    if (n < 3) continue; // histórico insuficiente pra confiar na estatística
    const media = Number(h.media), desvio = Number(h.desvio);
    if (desvio === 0) continue;

    const limiteSuperior = media + 1.5 * desvio;
    const limiteInferior = Math.max(0, media - 1.5 * desvio);
    if (receitaOntem <= limiteSuperior && receitaOntem >= limiteInferior) continue;

    const acima = receitaOntem > limiteSuperior;
    const diffPct = media > 0 ? ((receitaOntem - media) / media) * 100 : 0;
    outliers.push({
      store_id: store.id, nickname: store.nickname, dia_do_mes: diaDoMes,
      receita_ontem: receitaOntem, media, desvio, meses_analisados: n,
      diff_pct: Number(diffPct.toFixed(1)), acima,
    });
  }
  return outliers;
}

// Itens mais vendidos nas últimas N horas que estão com estoque baixo —
// cruza getTopVendas com available_quantity, mesmo threshold "medium" já
// usado em GET /api/alertas/reposicao (business-rules.md, reaproveitado).
async function getEstoqueCriticoTopVendas({ hours = 24, estoqueMax = 15, limit = 10 } = {}) {
  const top = await getTopVendas({ hours, limit: 50 });
  if (!top.length) return [];

  const itemIds = top.map(r => r.item_id).filter(Boolean);
  if (!itemIds.length) return [];

  const { rows } = await pool.query(
    `SELECT ml_id AS item_id, available_quantity FROM vw_ml_items WHERE ml_id = ANY($1::text[])`,
    [itemIds]
  );
  const estoqueByItem = new Map(rows.map(r => [r.item_id, Number(r.available_quantity)]));

  return top
    .map(r => ({ ...r, available_quantity: estoqueByItem.has(r.item_id) ? estoqueByItem.get(r.item_id) : null }))
    .filter(r => r.available_quantity != null && r.available_quantity <= estoqueMax)
    .sort((a, b) => a.available_quantity - b.available_quantity)
    .slice(0, limit);
}

// Margem de Contribuição por loja (funil do Mercado Turbo). Fonte única usada
// pela rota /api/vendas/margem e pelo fechamento diário no worker. Precedência
// da taxa por pedido (ver finance.md): Conciliação (mp_account_movements) →
// pagamento em tempo real (ml_payments: transaction_amount − net_received_amount)
// → ml_fee/shipping_seller_cost do pedido. Frete do comprador só entra se
// considerarFC=true. Aceita {dateFrom,dateTo} OU {days} (default 30, máx 90).
async function getMargemPorLoja({ dateFrom, dateTo, days, considerarFC = false } = {}) {
  let periodo, params;
  if (dateFrom && dateTo) {
    periodo = `o.date_created >= $1::timestamptz AND o.date_created <= $2::timestamptz`;
    params = [dateFrom, `${dateTo} 23:59:59`];
  } else {
    const d = Math.min(parseInt(days) || 30, 90);
    periodo = `o.date_created >= CURRENT_DATE - ($1::int)`;
    params = [d];
  }
  const freteMotoboy = await buscarFreteMotoboy();
  // frete_vendedor_manual (v86) vence tudo, inclusive o motoboy — mesmo
  // escape hatch de tarifa_manual.
  const freteVendCalculado = `CASE WHEN o.frete_vendedor_manual IS NOT NULL THEN o.frete_vendedor_manual
             WHEN c.tarifa_real IS NOT NULL THEN COALESCE(c.frete_vend_real,0)
             WHEN pg.taxa_pgto IS NOT NULL THEN 0
             ELSE COALESCE(o.shipping_seller_cost,0) END`;
  // Frete motoboy Flex (business-rules.md) — mesma substituição de calcularMargemLinha.
  const freteVendSql = freteMotoboy.ativo
    ? `CASE WHEN o.frete_vendedor_manual IS NOT NULL THEN o.frete_vendedor_manual
            WHEN o.shipping_type = 'self_service' THEN GREATEST(0, ${freteMotoboy.valor} - COALESCE(o.shipping_seller_reembolso,0))
            ELSE ${freteVendCalculado} END`
    : freteVendCalculado;
  const { rows } = await pool.query(`
    WITH per_order AS (
      SELECT o.store_id, s.nickname AS loja, o.status, o.total_amount,
        COALESCE(i.cost,0)*o.quantity AS custo,
        o.total_amount*COALESCE(s.imposto_pct,0)/100 AS imposto,
        o.shipping_cost AS frete_comprador,
        COALESCE(o.tarifa_manual, c.tarifa_real, pg.taxa_pgto, o.ml_fee, 0) AS tarifa,
        ${freteVendSql} AS frete_vendedor,
        (c.tarifa_real IS NOT NULL OR pg.taxa_pgto IS NOT NULL) AS tem_taxa_real
      FROM vw_ml_orders o
      JOIN vw_ml_stores s ON s.id=o.store_id
      LEFT JOIN items i ON i.ml_id=o.item_id
      ${CONCILIACAO_TARIFA_LATERAL}
      LEFT JOIN LATERAL (
        SELECT SUM(p.transaction_amount) - SUM(p.net_received_amount) AS taxa_pgto
        FROM ml_payments p
        WHERE p.order_id = o.ml_id AND p.net_received_amount IS NOT NULL
          AND p.status = 'approved'
      ) pg ON true
      WHERE ${periodo}
    )
    SELECT store_id, loja,
      SUM(total_amount) AS faturamento,
      COALESCE(SUM(total_amount) FILTER (WHERE status='cancelled'),0) AS canceladas,
      COALESCE(SUM(total_amount) FILTER (WHERE status<>'cancelled'),0) AS aprovadas,
      COUNT(*) FILTER (WHERE status<>'cancelled') AS qtd_aprovadas,
      COALESCE(SUM(custo) FILTER (WHERE status<>'cancelled'),0) AS custo,
      COALESCE(SUM(imposto) FILTER (WHERE status<>'cancelled'),0) AS imposto,
      COALESCE(SUM(tarifa) FILTER (WHERE status<>'cancelled'),0) AS tarifa,
      COALESCE(SUM(frete_vendedor) FILTER (WHERE status<>'cancelled'),0) AS frete_vendedor,
      COALESCE(SUM(frete_comprador) FILTER (WHERE status<>'cancelled'),0) AS frete_comprador,
      COUNT(*) FILTER (WHERE status<>'cancelled' AND tem_taxa_real) AS pedidos_conciliados,
      bool_or(tem_taxa_real) AS tem_conciliacao
    FROM per_order
    GROUP BY store_id, loja
    ORDER BY aprovadas DESC
  `, params);
  const n = (x) => Number(x) || 0;
  return rows.map(r => {
    const aprovadas = n(r.aprovadas), custo = n(r.custo), imposto = n(r.imposto),
          tarifa = n(r.tarifa), freteV = n(r.frete_vendedor), freteC = n(r.frete_comprador);
    const margem = aprovadas - custo - imposto - tarifa - freteV - (considerarFC ? freteC : 0);
    return {
      store_id: r.store_id, loja: r.loja,
      faturamento: n(r.faturamento), canceladas: n(r.canceladas), aprovadas,
      qtd_aprovadas: n(r.qtd_aprovadas), custo, imposto, tarifa,
      frete_vendedor: freteV, frete_comprador: freteC,
      pedidos_conciliados: n(r.pedidos_conciliados), tem_conciliacao: r.tem_conciliacao,
      margem, margem_pct: aprovadas > 0 ? Number((margem / aprovadas * 100).toFixed(2)) : 0,
    };
  });
}

// Ruptura iminente — item que VENDE BEM e vai acabar. Fonte única usada pela
// rota /api/alertas/ruptura e pelo alerta Telegram diário. dias_restantes =
// estoque ÷ (unidades vendidas na janela ÷ dias), velocidade REAL de
// vw_ml_orders. Ver business-rules.md.
async function getRupturaEstoque({ janela = 30, dias = 7, minVendaDia = 0.2, storeId = '' } = {}) {
  janela = Math.min(Math.max(parseInt(janela) || 30, 7), 90);
  dias = Math.min(Math.max(parseInt(dias) || 7, 1), 60);
  minVendaDia = Number(minVendaDia ?? 0.2);
  const params = [janela, dias, minVendaDia];
  let storeFilter = '';
  if (storeId) { params.push(storeId); storeFilter = `AND i.store_id = $${params.length}::bigint`; }
  const { rows } = await pool.query(`
    WITH vendas AS (
      SELECT o.item_id, SUM(o.quantity)::float AS un
      FROM vw_ml_orders o
      WHERE o.status <> 'cancelled' AND o.date_created >= CURRENT_DATE - ($1::int)
      GROUP BY o.item_id
    )
    SELECT i.ml_id, i.store_id, COALESCE(s.nickname,'—') AS loja, i.title, i.price,
           i.available_quantity AS stock, i.permalink, i.thumbnail,
           (v.un / $1::float) AS venda_dia,
           (i.available_quantity / (v.un / $1::float)) AS dias_restantes
    FROM vw_ml_items i
    JOIN vendas v ON v.item_id = i.ml_id
    LEFT JOIN vw_ml_stores s ON s.id = i.store_id
    WHERE i.status='active' AND v.un > 0
      AND (v.un / $1::float) >= $3::float
      AND (i.available_quantity / (v.un / $1::float)) < $2::float
      ${storeFilter}
    ORDER BY dias_restantes ASC
    LIMIT 200
  `, params);
  return {
    janela, dias, min_venda_dia: minVendaDia,
    items: rows.map(r => ({
      ...r,
      venda_dia: Number(Number(r.venda_dia).toFixed(2)),
      dias_restantes: Math.floor(Number(r.dias_restantes)),
      sugestao_compra: Math.max(0, Math.ceil(Number(r.venda_dia) * janela) - Number(r.stock)),
    })),
  };
}

module.exports = { getResumoDiarioData, getTopVendas, getResumoSemanal, getOutliersOntem, getEstoqueCriticoTopVendas, getMargemPorLoja, getRupturaEstoque };
