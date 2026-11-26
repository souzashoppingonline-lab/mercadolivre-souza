// Raio-X do anúncio (v189) — leitura no banco (sem nenhuma chamada a ML/Shopee).
// Contas puras em ./raioX.js. Rota: GET /api/bi/analista-ecom/item/:mlId/raio-x.
//   ML     → vendas de orders.item_id, visitas de item_visits, buy box, qualidade, devoluções.
//   Shopee → orders não tem item_id: vendas saem do item_list do pedido (shopee_order_data);
//            sem visitas diárias, buy box, nota de qualidade nem devoluções (ML-only).
const pool = require('./db/pool');
const analistaEcom = require('./analistaEcom');
const raioX = require('./raioX');
const { fotoGrande } = require('./telegramLog');

const DEVOLUCOES_DIAS = 90;
const QUANDO_VENDE_DIAS = 90;

// Série diária de vendas de 1 item Shopee, mesmo formato de getHistoricoItem (visitas = 0).
async function historicoShopee(itemId, totalDias) {
  const { rows } = await pool.query(
    `WITH dias AS (SELECT generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, INTERVAL '1 day')::date AS dia),
     vendas AS (
       SELECT o.date_created::date AS dia, COUNT(DISTINCT o.ml_id)::int AS pedidos,
              COALESCE(SUM(NULLIF(it->>'model_quantity_purchased', '')::int), 0)::int AS unidades
         FROM orders o
         JOIN shopee_order_data s ON s.order_id = o.ml_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_data->'item_list', '[]'::jsonb)) it
        WHERE it->>'item_id' = $1 AND o.status <> 'cancelled' AND o.date_created >= CURRENT_DATE - ($2::int - 1)
        GROUP BY 1)
     SELECT d.dia, COALESCE(v.pedidos, 0) AS pedidos, COALESCE(v.unidades, 0) AS unidades
       FROM dias d LEFT JOIN vendas v ON v.dia = d.dia ORDER BY d.dia`,
    [String(itemId), totalDias]);
  return rows.map((r) => ({ data: r.dia.toISOString().slice(0, 10), pedidos: r.pedidos, unidades: r.unidades, visitas: 0 }));
}

async function montarRaioX(mlId) {
  const { rows } = await pool.query(
    `SELECT i.ml_id, i.title, i.thumbnail, i.permalink, i.price, i.available_quantity, i.status, i.store_id,
            i.cost, i.cost_updated_at, s.nickname AS loja, COALESCE(m.code, 'ML') AS marketplace
       FROM items i LEFT JOIN stores s ON s.id = i.store_id LEFT JOIN marketplaces m ON m.id = i.marketplace_id
      WHERE i.ml_id = $1`, [mlId]);
  if (!rows.length) return null;
  const item = rows[0];
  const ml = item.marketplace !== 'SHOPEE';

  const dias = ml ? (await analistaEcom.getHistoricoItem(mlId, raioX.DIAS_SERIE_RAIO_X)).dias
    : await historicoShopee(mlId, raioX.DIAS_SERIE_RAIO_X);

  // Quando vende (dia da semana × hora, fuso SP, 90 dias) — ML por orders.item_id, Shopee pelo item_list.
  const quandoSql = ml
    ? `SELECT EXTRACT(DOW FROM date_created AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
              EXTRACT(HOUR FROM date_created AT TIME ZONE 'America/Sao_Paulo')::int AS hora, COALESCE(SUM(quantity), 0)::int AS unidades
         FROM orders WHERE item_id = $1 AND status <> 'cancelled' AND date_created >= now() - ($2::int * INTERVAL '1 day') GROUP BY 1, 2`
    : `SELECT EXTRACT(DOW FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
              EXTRACT(HOUR FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
              COALESCE(SUM(NULLIF(it->>'model_quantity_purchased', '')::int), 0)::int AS unidades
         FROM orders o JOIN shopee_order_data s ON s.order_id = o.ml_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_data->'item_list', '[]'::jsonb)) it
        WHERE it->>'item_id' = $1 AND o.status <> 'cancelled' AND o.date_created >= now() - ($2::int * INTERVAL '1 day') GROUP BY 1, 2`;
  const [quando, precos, promos] = await Promise.all([
    pool.query(quandoSql, [mlId, QUANDO_VENDE_DIAS]),
    pool.query(`SELECT old_price, new_price, changed_at FROM price_history WHERE item_id = $1 AND changed_at >= CURRENT_DATE - 30 ORDER BY changed_at`, [mlId]),
    pool.query(`SELECT status, previous_status, promo_price, discount_pct, changed_at FROM promotions WHERE item_id = $1 AND changed_at >= CURRENT_DATE - 30 ORDER BY changed_at`, [mlId]),
  ]);

  const [seo, bb, dev] = ml ? await Promise.all([
    pool.query(`SELECT * FROM item_seo_score WHERE item_id = $1`, [mlId]),
    pool.query(`SELECT * FROM catalog_competition WHERE item_id = $1`, [mlId]),
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM orders WHERE item_id = $1 AND status <> 'cancelled'
                 AND date_created >= now() - ($2::int * INTERVAL '1 day')) AS pedidos,
              COALESCE((SELECT json_agg(json_build_object('reason', r.reason, 'status', r.status, 'date', r.date) ORDER BY r.date DESC)
                 FROM returns r JOIN orders o ON o.ml_id = r.order_id
                WHERE o.item_id = $1 AND r.date >= now() - ($2::int * INTERVAL '1 day')), '[]'::json) AS devolucoes`,
      [mlId, DEVOLUCOES_DIAS]),
  ]) : [null, null, null];

  const resumo = raioX.resumirRaioX({ dias, estoque: item.available_quantity });
  const buybox = ml ? raioX.resumoBuybox(bb.rows[0], mlId) : null;
  return {
    item: {
      ml_id: item.ml_id, title: item.title, thumbnail: fotoGrande(item.thumbnail), permalink: item.permalink,
      price: item.price == null ? null : Number(item.price), available_quantity: item.available_quantity, status: item.status,
      store_id: item.store_id, loja: item.loja, marketplace: item.marketplace,
      // Custo por anúncio (items.cost) — o mesmo que o "Resumo por Venda" usa. Sem cost_updated_at = nunca confirmado.
      custo: item.cost_updated_at ? Number(item.cost) : null, custo_atualizado_em: item.cost_updated_at,
    },
    dias: dias.slice(-raioX.DIAS_GRAFICO),   // gráfico: 30 dias + hoje (a série inteira de 61 só entra nas contas)
    ...resumo,
    sem_visitas: !ml,
    qualidade: ml ? raioX.pendenciasSeo(seo.rows[0]) : null,
    buybox,
    mes_passado: raioX.comparacaoMes(dias),
    eventos: raioX.eventosPreco({ precos: precos.rows, promocoes: promos.rows }),
    quando_vende: raioX.quandoVende(quando.rows, QUANDO_VENDE_DIAS),
    alerta_queda: raioX.alertaQueda({ tendencia: resumo.tendencia, buybox, cobertura: resumo.cobertura }),
    devolucoes: ml ? raioX.resumoDevolucoes({ devolucoes: dev.rows[0].devolucoes, pedidos: dev.rows[0].pedidos, dias: DEVOLUCOES_DIAS }) : null,
  };
}

module.exports = { montarRaioX, historicoShopee, DEVOLUCOES_DIAS, QUANDO_VENDE_DIAS };
