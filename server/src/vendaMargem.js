// SELECT + fórmula de margem por pedido — fonte única, usada por:
//  - routes/api.js (`GET /vendas/detalhado`, listagem)
//  - routes/bi.js (`GET /bi/margem`, Inteligência de Margem — agrega por item_id)
//  - financeService.js (reconciliação, devolve a linha recalculada depois de
//    atualizar tarifa/frete)
// Extraído pra módulo próprio (v82) quando um 4º consumidor apareceu — antes
// vivia dentro de routes/api.js e era exportado como propriedade do router
// (funcionava, mas ficava estranho fora de rota). Nunca duplicar esta fórmula
// em outro lugar — ver finance.md.
const VENDA_DETALHE_SELECT = `
     SELECT
       o.ml_id, o.store_id, s.nickname as conta, o.item_id,
       o.title, o.quantity, o.unit_price,
       o.total_amount as faturamento,
       o.buyer_nickname,
       -- Tela "Resumo por venda" (card BI): campos que só existem dentro do
       -- payload cru do pedido — não valia coluna própria só pra isso.
       -- Nome real do comprador nem sempre vem preenchido pelo ML.
       o.raw_data->'buyer'->>'first_name' as buyer_first,
       o.raw_data->'buyer'->>'last_name' as buyer_last,
       o.raw_data->>'pack_id' as pack_id,
       COALESCE(
         o.raw_data->'order_items'->0->'item'->>'seller_sku',
         o.raw_data->'order_items'->0->'item'->>'seller_custom_field'
       ) as sku,
       i.thumbnail, i.available_quantity as estoque_atual, i.category_id,
       CASE WHEN c.tarifa_real IS NOT NULL THEN c.tarifa_real
            WHEN pg.taxa_pgto IS NOT NULL THEN pg.taxa_pgto - LEAST(COALESCE(o.shipping_seller_cost,0), pg.taxa_pgto)
            ELSE COALESCE(o.ml_fee, 0) END as tarifa,
       o.shipping_type as frete_tipo,
       o.shipping_cost as frete_comprador,
       CASE WHEN c.tarifa_real IS NOT NULL THEN COALESCE(c.frete_vend_real, 0)
            WHEN pg.taxa_pgto IS NOT NULL THEN LEAST(COALESCE(o.shipping_seller_cost,0), pg.taxa_pgto)
            ELSE COALESCE(o.shipping_seller_cost, 0) END as frete_vendedor,
       (c.tarifa_real IS NOT NULL) as tem_conciliacao,
       CASE WHEN c.tarifa_real IS NOT NULL THEN 'conciliacao'
            WHEN pg.taxa_pgto IS NOT NULL THEN 'pagamento'
            ELSE 'pedido' END as fonte_taxa,
       o.status, o.date_created,
       o.finance_synced, o.last_finance_sync_at,
       COALESCE(i.cost, 0) as custo,
       COALESCE(s.imposto_pct, 0) as imposto_pct
     FROM vw_ml_orders o
     JOIN vw_ml_stores s ON s.id = o.store_id
     LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
     LEFT JOIN LATERAL (
       SELECT ABS(SUM(m.mp_fee_amount)) AS tarifa_real,
              ABS(SUM(m.shipping_fee_amount)) AS frete_vend_real
       FROM mp_account_movements m
       WHERE m.order_id = o.ml_id AND m.description = 'Payment'
     ) c ON true
     LEFT JOIN LATERAL (
       SELECT NULLIF(GREATEST(SUM(p.transaction_amount) - SUM(p.net_received_amount), 0), 0) AS taxa_pgto
       FROM ml_payments p
       WHERE p.order_id = o.ml_id AND p.net_received_amount IS NOT NULL
         AND p.status = 'approved'
     ) pg ON true`;

// Aplica a fórmula de margem (finance.md) em cima de 1 linha crua da query
// acima. Nunca duas fórmulas de margem no projeto.
function calcularMargemLinha(r) {
  const fat = Number(r.faturamento) || 0;
  const custo = Number(r.custo) * (Number(r.quantity) || 1);
  const imposto = fat * (Number(r.imposto_pct) / 100);
  const tarifa = Number(r.tarifa) || 0;
  const freteVend = Number(r.frete_vendedor) || 0;
  const freteComp = Number(r.frete_comprador) || 0;
  const margem = fat - custo - imposto - tarifa - freteComp - freteVend;
  const mc_pct = fat > 0 ? (margem / fat) * 100 : 0;
  return { ...r, custo, imposto, tarifa, freteVend, margem, mc_pct: Number(mc_pct.toFixed(2)) };
}

module.exports = { VENDA_DETALHE_SELECT, calcularMargemLinha };
