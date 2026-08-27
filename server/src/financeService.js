// Reconciliação financeira de 1 pedido — FONTE ÚNICA usada por:
//  - routes/api.js (`POST /vendas/:orderId/atualizar`, botão manual "Atualizar")
//  - worker.js (`financeReconciliationJob`, a cada 10 min — só pedidos pendentes)
// Pedido explícito do usuário: os dois caminhos usam EXATAMENTE este serviço,
// nunca lógica duplicada — evita divergência entre atualização manual e
// automática. Ver .claude/decisions.md ("Reconciliação de Frete e Tarifa").
//
// Regra do NULL vs. zero: `orders.ml_fee`/`shipping_seller_cost` já nascem
// com DEFAULT 0 no schema (não são NULL nunca) — então "pendente" não pode
// ser lido dessas colunas. Em vez disso, `orders.finance_synced` (v82) é o
// marcador dedicado: só vira `true` quando tarifa E frete do vendedor foram
// CONFIRMADOS por uma chamada real à API nesta função (mesmo que o valor
// confirmado seja 0 — 0 confirmado é dado bom, `finance_synced=false` é que
// significa "ainda não sei").
const pool = require('./db/pool');
const redis = require('./db/redis');
const ml = require('./mlClient');
const { VENDA_DETALHE_SELECT, calcularMargemLinha, buscarImpostoFlexAtivo } = require('./vendaMargem');

// Reconsulta 1 pedido na API do ML e atualiza tudo que dá pra confirmar agora:
//  1) /orders/:id — ml_fee, shipping_cost/type/id, raw_data inteiro (também
//     atualiza buyer/pack_id/sku, usados pelo card "Resumo por Venda").
//  2) /shipments/:id/costs — frete do vendedor (senders[].cost, NUNCA
//     gross_amount nem o frete do comprador).
//  3) /collections/:id — tarifa real, upsert em ml_payments (mesmo shape do
//     handlePayment do worker).
// Nunca lança pra falha esperada de API (404/429/sem shipment/sem pagamento
// ainda) — sempre devolve um resultado, pra tanto a rota manual quanto o job
// automático decidirem o que fazer sem precisar de try/catch próprio.
async function reconciliarPedido(orderId) {
  const { rows: ord } = await pool.query(
    `SELECT store_id, shipping_id FROM orders WHERE ml_id = $1`, [orderId]
  );
  if (!ord.length) return { ok: false, error: 'pedido não encontrado' };
  const storeId = ord[0].store_id;
  const shippingIdAntigo = ord[0].shipping_id;

  let shippingError = null, paymentError = null, orderError = null;
  let freteConfirmado = false, tarifaConfirmada = false;
  let order = null;

  // 1) Pedido — se isto falhar (404/401/429/rede), não dá pra seguir pros
  // outros dois passos (não sabemos payments[]/shipping.id sem o pedido).
  try {
    order = await ml.getOrder(orderId, storeId);
    const item0 = order.order_items?.[0] || {};
    await pool.query(
      `UPDATE orders SET
         ml_fee = $2, shipping_cost = $3,
         shipping_type = COALESCE(NULLIF($4, ''), shipping_type),
         shipping_id = COALESCE($5, shipping_id),
         raw_data = $6, updated_at = now()
       WHERE ml_id = $1`,
      [
        orderId, item0.sale_fee || 0, order.shipping?.cost || 0,
        order.shipping?.logistic_type || '',
        order.shipping?.id ? String(order.shipping.id) : null,
        JSON.stringify(order),
      ]
    );
  } catch (e) {
    orderError = e.message;
  }

  if (order) {
    // 2) Frete do vendedor.
    const shippingId = (order.shipping?.id ? String(order.shipping.id) : null) || shippingIdAntigo;
    if (!shippingId) {
      // Pedido sem envio associado (ex.: retirada, ou ainda não gerado) —
      // não é erro, é "não aplicável": não fica pendindo pra sempre esperando
      // um shipment que pode nunca existir.
      freteConfirmado = true;
    } else {
      try {
        const costs = await ml.getShipmentCosts(shippingId, storeId);
        const senders = costs?.senders;
        let sellerCost = null;
        if (Array.isArray(senders)) sellerCost = senders.reduce((a, s) => a + (Number(s?.cost) || 0), 0);
        else if (senders && senders.cost != null) sellerCost = Number(senders.cost) || 0;
        if (sellerCost != null) {
          await pool.query(`UPDATE orders SET shipping_seller_cost=$2 WHERE ml_id=$1`, [orderId, sellerCost]);
          freteConfirmado = true;   // API confirmou o valor — mesmo que seja 0
        } else {
          shippingError = 'resposta sem senders[].cost';
        }
      } catch (e) {
        shippingError = e.message;   // logística sem custo exposto (ex: coleta) — não é erro fatal, só não confirma
      }
    }

    // 3) Tarifa real via pagamento.
    const paymentId = order.payments?.[0]?.id;
    if (!paymentId) {
      // Pedido sem pagamento ainda registrado no /orders/:id — não dá pra
      // confirmar tarifa agora; NÃO marca como confirmado (fica pendente,
      // tenta de novo na próxima janela — o pagamento pode chegar depois).
    } else {
      try {
        const payment = await ml.getPayment(paymentId, storeId);
        const c = payment?.collection || payment;
        await pool.query(
          `INSERT INTO ml_payments (
             payment_id, order_id, store_id, status, status_detail, transaction_amount,
             date_created, date_approved, net_received_amount, money_release_date, released,
             marketplace_fee, mercadopago_fee, discount_fee, coupon_fee, finance_fee,
             amount_refunded, shipping_cost, payment_method_id, payment_type, installments,
             raw_data, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
           ON CONFLICT (payment_id) DO UPDATE SET
             status = EXCLUDED.status, status_detail = EXCLUDED.status_detail,
             transaction_amount = EXCLUDED.transaction_amount,
             net_received_amount = EXCLUDED.net_received_amount,
             money_release_date = EXCLUDED.money_release_date, released = EXCLUDED.released,
             marketplace_fee = EXCLUDED.marketplace_fee, mercadopago_fee = EXCLUDED.mercadopago_fee,
             discount_fee = EXCLUDED.discount_fee, coupon_fee = EXCLUDED.coupon_fee,
             finance_fee = EXCLUDED.finance_fee, amount_refunded = EXCLUDED.amount_refunded,
             shipping_cost = EXCLUDED.shipping_cost, payment_method_id = EXCLUDED.payment_method_id,
             payment_type = EXCLUDED.payment_type, installments = EXCLUDED.installments,
             raw_data = EXCLUDED.raw_data, updated_at = now()`,
          [
            paymentId, orderId, storeId, c?.status || null, c?.status_detail || null,
            c?.transaction_amount || null, c?.date_created || null, c?.date_approved || null,
            c?.net_received_amount ?? null, c?.money_release_date || null, c?.released ?? null,
            c?.marketplace_fee ?? null, c?.mercadopago_fee ?? null, c?.discount_fee ?? null,
            c?.coupon_fee ?? null, c?.finance_fee ?? null, c?.amount_refunded ?? null,
            c?.shipping_cost ?? null, c?.payment_method_id || null, c?.payment_type || null,
            c?.installments ?? null, JSON.stringify(payment),
          ]
        );
        tarifaConfirmada = true;
      } catch (e) {
        paymentError = e.message;
      }
    }
  }

  // finance_synced só vira true quando os DOIS lados foram confirmados por
  // uma chamada real — nunca por omissão. Idempotente: sempre SET (nunca
  // soma), então rodar 2x seguidas não duplica nem infla nada.
  const financeSynced = freteConfirmado && tarifaConfirmada;
  const erroDeste = orderError || shippingError || paymentError || null;
  await pool.query(
    `UPDATE orders SET
       finance_synced = $2,
       finance_sync_attempts = CASE WHEN $2 THEN 0 ELSE finance_sync_attempts + 1 END,
       last_finance_sync_at = now(),
       last_finance_sync_error = $3
     WHERE ml_id = $1`,
    [orderId, financeSynced, erroDeste]
  );

  await redis.del(`kpis:${storeId}`);
  await redis.del('kpis:summary');

  if (orderError) {
    return { ok: false, error: orderError, finance_synced: false };
  }

  // Devolve a linha já recalculada (mesma fórmula/SELECT de /vendas/detalhado)
  // — quem chamou (botão ou job) usa isso pra atualizar a tela/log sem
  // esperar o cache de 60s da listagem.
  const { rows: fresh } = await pool.query(`${VENDA_DETALHE_SELECT} WHERE o.ml_id = $1 LIMIT 1`, [orderId]);
  if (!fresh.length) return { ok: false, error: 'pedido não encontrado após atualizar', finance_synced: financeSynced };
  return {
    ok: true,
    row: calcularMargemLinha(fresh[0], await buscarImpostoFlexAtivo()),
    shipping_error: shippingError,
    payment_error: paymentError,
    finance_synced: financeSynced,
  };
}

module.exports = { reconciliarPedido };
