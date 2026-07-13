// Consultas de relatório compartilhadas entre o worker (Telegram/e-mail) e a
// API HTTP (páginas do dashboard) — única fonte de verdade por cálculo,
// nunca duplicar a mesma query em mais de um lugar.
const pool = require('./db/pool');

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

module.exports = { getResumoDiarioData, getTopVendas, getResumoSemanal, getOutliersOntem, getEstoqueCriticoTopVendas };
