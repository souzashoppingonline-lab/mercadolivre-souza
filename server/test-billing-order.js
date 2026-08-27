// Script exploratório (não roda em produção automaticamente, só sob demanda)
// pra confirmar se a API do Mercado Livre expõe bonificação/subsídio de
// frete Flex por PEDIDO, e se dá pra amarrar isso a um order_id específico
// — pedido do usuário, venda de exemplo com reembolso de frete de R$10,99.
//
// Testa endpoints NUNCA chamados neste projeto antes:
//   1) GET /billing/integration/group/{group}/order/details?order_ids={id}
//      (sugerido pelo usuário — grupo ML e MP, já que não sabemos qual
//      cobre bonificação de frete)
//   2) GET /collections/{payment_id} completo — pra reexaminar amount_refunded/
//      refunds[] com uma venda que teve reembolso de verdade (conciliacao-
//      bancaria.md já registra que esse campo nunca veio preenchido até hoje)
//   3) GET /shipments/{shipping_id}/costs — o custo "oficial" de frete do
//      vendedor pra esse envio, pra comparar com o que já temos salvo
//
// Antes de qualquer chamada à API, também dá uma olhada no que JÁ está
// salvo localmente (orders/ml_payments/mp_account_movements/ml_billing_charges)
// — pode já responder a pergunta sem gastar rate limit nenhum.
//
// Uso: node server/test-billing-order.js <order_id_ou_payment_id>
// Ex.:  node server/test-billing-order.js 2000018146767714
require('dotenv').config();
const pool = require('./src/db/pool');

const ID_ALVO = process.argv[2];
if (!ID_ALVO) {
  console.error('Uso: node server/test-billing-order.js <order_id_ou_payment_id>');
  process.exit(1);
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* resposta não-JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\n════ 1) O que já está salvo localmente pra "${ID_ALVO}" ════\n`);

  // Pode ser order_id (orders.ml_id) OU payment_id (ml_payments.payment_id) —
  // testa os dois, sem assumir qual é.
  const { rows: porOrder } = await pool.query(
    `SELECT ml_id, store_id, item_id, title, total_amount, shipping_type, shipping_cost,
            shipping_seller_cost, shipping_id, ml_fee, status, date_created
     FROM orders WHERE ml_id = $1`, [ID_ALVO]
  );
  const { rows: porPayment } = await pool.query(
    `SELECT payment_id, order_id, store_id, status, transaction_amount, net_received_amount,
            amount_refunded, shipping_cost, marketplace_fee, mercadopago_fee, raw_data
     FROM ml_payments WHERE payment_id = $1`, [ID_ALVO]
  );
  console.log('orders (por ml_id):', porOrder.length ? porOrder : '(nada)');
  console.log('ml_payments (por payment_id):', porPayment.length
    ? porPayment.map(r => ({ ...r, raw_data: '(omitido, ' + JSON.stringify(r.raw_data).length + ' bytes — ver abaixo se precisar)' }))
    : '(nada)');

  // order_id real e store_id, não importa por qual caminho achamos
  const orderId = porOrder[0]?.ml_id || porPayment[0]?.order_id || ID_ALVO;
  const storeId = porOrder[0]?.store_id || porPayment[0]?.store_id;
  const shippingId = porOrder[0]?.shipping_id;

  if (porPayment.length && porPayment[0].amount_refunded != null) {
    console.log(`\n>>> ml_payments.amount_refunded JÁ SALVO: ${porPayment[0].amount_refunded} <<<`);
    console.log('raw_data completo (procurar por "refund"/"shipping" manualmente):');
    console.log(JSON.stringify(porPayment[0].raw_data, null, 2));
  }

  const { rows: movs } = await pool.query(
    `SELECT id, description, order_id, shipping_id, net_credit_amount, net_debit_amount,
            gross_amount, mp_fee_amount, shipping_fee_amount, sale_detail, release_date
     FROM mp_account_movements WHERE order_id = $1 OR shipping_id = $2 ORDER BY release_date`,
    [orderId, shippingId || null]
  );
  console.log(`\nmp_account_movements pra order_id=${orderId} / shipping_id=${shippingId}:`, movs.length ? movs : '(nada)');
  if (!movs.length) {
    console.log('(dica: pode não ter chegado ainda no relatório de liberação — job roda 05:40, ou o pedido pode ser antigo demais)');
  }

  // ml_billing_charges não tem order_id (ver conciliacao-bancaria.md) — procura
  // no raw_data por menção ao order_id/shipping_id/valor 10.99, e lista o período
  // pra saber se cobre a data dessa venda.
  const { rows: billingPerto } = await pool.query(
    `SELECT id, billing_group, period_key, detail_type, detail_sub_type, transaction_detail,
            detail_amount, creation_date_time
     FROM ml_billing_charges
     WHERE store_id = $1 AND (raw_data::text ILIKE $2 OR raw_data::text ILIKE $3 OR detail_amount = 10.99)
     ORDER BY creation_date_time DESC LIMIT 20`,
    [storeId, `%${orderId}%`, shippingId ? `%${shippingId}%` : '%__nunca_bate__%']
  );
  console.log(`\nml_billing_charges (store=${storeId}) mencionando order_id/shipping_id ou com valor 10.99:`, billingPerto.length ? billingPerto : '(nada)');
  const { rows: periodosCobertos } = await pool.query(
    `SELECT DISTINCT billing_group, period_key FROM ml_billing_charges WHERE store_id = $1 ORDER BY period_key DESC LIMIT 10`,
    [storeId]
  );
  console.log('Períodos de billing já sincronizados nesta loja (só o período OPEN de cada vez que o job rodou):', periodosCobertos);

  if (!storeId) {
    console.log('\nNão achei store_id pra esse ID — não dá pra chamar a API sem saber qual loja/token usar. Confere o ID.');
    await pool.end();
    return;
  }

  const { rows: storeRows } = await pool.query(`SELECT id, nickname, access_token FROM stores WHERE id = $1`, [storeId]);
  const store = storeRows[0];
  if (!store?.access_token) {
    console.log(`\nLoja ${storeId} sem access_token salvo — não dá pra chamar a API.`);
    await pool.end();
    return;
  }
  const token = store.access_token;
  console.log(`\n════ 2) Chamadas NOVAS à API do ML (loja ${store.nickname}, order_id=${orderId}) ════\n`);

  for (const group of ['ML', 'MP']) {
    const url = `https://api.mercadolibre.com/billing/integration/group/${group}/order/details?order_ids=${orderId}`;
    const r = await fetchJson(url, token);
    console.log(`\n[${group}] GET /billing/integration/group/${group}/order/details?order_ids=${orderId}`);
    console.log(`  status=${r.status}`);
    console.log(' ', r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 1500));
    await new Promise(res => setTimeout(res, 1500));
  }

  if (porPayment.length) {
    const paymentId = porPayment[0].payment_id;
    const url = `https://api.mercadolibre.com/collections/${paymentId}`;
    const r = await fetchJson(url, token);
    console.log(`\n[collections] GET /collections/${paymentId} (reconsulta completa, comparar amount_refunded/refunds[])`);
    console.log(`  status=${r.status}`);
    console.log(' ', r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 2000));
  }

  if (shippingId) {
    const url = `https://api.mercadolibre.com/shipments/${shippingId}/costs`;
    const r = await fetchJson(url, token);
    console.log(`\n[shipments] GET /shipments/${shippingId}/costs`);
    console.log(`  status=${r.status}`);
    console.log(' ', r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 1500));
  } else {
    console.log('\n(sem shipping_id salvo localmente pra esse pedido — pula /shipments/:id/costs)');
  }

  console.log('\n════ Fim — cole a saída inteira de volta pra eu analisar ════\n');
  await pool.end();
})().catch(async e => { console.error('ERRO:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
