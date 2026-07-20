// Webhook Shopee ("Mecanismo de Empurra") — receptor de push de status de
// pedido. TOTALMENTE ISOLADO do gateway do Mercado Livre (routes/webhookGateway.js):
// arquivo, rota (/webhooks/shopee) e fila próprios. Mesma disciplina do gateway
// ML: responde 200 na hora e processa assíncrono; aqui, enfileira o MESMO evento
// padronizado que o polling já publica, então o handleShopeeOrderEvent
// (marketplaceEventWorker.js) processa igual — só que em tempo real.
//
// Assinatura: a Shopee assina `push_url|raw_body` com HMAC-SHA256(partner_key),
// no header Authorization. Precisa do corpo CRU — por isso este router usa
// express.raw() e é montado ANTES do express.json() global (ver server.js).
// Se a validação falhar, o push é logado (pra diagnosticar o formato) e NÃO é
// processado, a não ser que SHOPEE_WEBHOOK_VERIFY=false (escape hatch p/ 1º teste).
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');
const { getQueue } = require('../queues/marketplaceEventQueue');
const { publish } = require('../ws/hub');

const router = express.Router();

// GET — a Shopee faz um teste de conectividade ao cadastrar a push_url.
router.get('/', (req, res) => res.sendStatus(200));

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  res.sendStatus(200); // ack rápido — a Shopee espera 200 imediato

  try {
    // A Shopee assina o push com a "Chave de parceiro Live Push" (separada da
    // partner_key da API). Fallback pra partnerKey se a de push não estiver no .env.
    const partnerKey = env.shopee.pushPartnerKey || env.shopee.partnerKey;
    const authHeader = req.get('Authorization') || '';
    // push_url exata que a Shopee chamou (tem que bater com a cadastrada no console).
    const pushUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    let verified = false;
    if (partnerKey && authHeader) {
      const expected = crypto.createHmac('sha256', partnerKey).update(`${pushUrl}|${rawBody}`).digest('hex');
      try { verified = crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected)); } catch { verified = false; }
      if (!verified) console.warn(`[shopee-webhook] assinatura não confere — recebida=${authHeader.slice(0, 20)}… esperada=${expected.slice(0, 20)}… url=${pushUrl}`);
    }

    const payload = JSON.parse(rawBody || '{}');
    // Log pra diagnóstico do formato real do push (code/shop/dados).
    console.log(`[shopee-webhook] code=${payload.code} shop=${payload.shop_id} verified=${verified} body=${rawBody.slice(0, 300)}`);

    // Segurança: sem assinatura válida, não processa (a não ser que desligado).
    if (env.shopee.webhookVerify && partnerKey && !verified) return;

    // A Shopee usa `code` pra tipo de push; 3 = order status. Aceitamos qualquer
    // push que traga um order_sn (o handler re-consulta o pedido de qualquer jeito).
    const shopId = payload.shop_id;
    const data = payload.data || {};
    const orderSn = data.ordersn || data.order_sn;
    if (!orderSn || !shopId) return;

    const { rows } = await pool.query(`SELECT id FROM stores WHERE shopee_shop_id = $1`, [shopId]);
    const storeId = rows[0]?.id;
    if (!storeId) { console.warn(`[shopee-webhook] shop_id ${shopId} sem loja cadastrada — ignorado`); return; }

    // Mesmo jobId do polling → BullMQ deduplica se os dois dispararem pro mesmo
    // pedido (o polling continua como rede de segurança). Exatamente 2 ':' (ver known-bugs).
    const jobId = `SHOPEE:ORDER_UPDATED:${storeId}-${orderSn}`;
    await getQueue('shopee').add('marketplace-event', {
      marketplace: 'SHOPEE',
      event: 'ORDER_UPDATED',
      resourceId: orderSn,
      storeId,
      timestamp: new Date().toISOString(),
    }, { jobId });

    await publish('webhook_received', { topic: 'shopee_order', resource: orderSn, store_id: storeId, status: 'pending' });
  } catch (e) {
    console.error('[shopee-webhook] erro:', e.message);
  }
});

module.exports = router;
