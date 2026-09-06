// Webhook TikTok Shop — receptor de push de status de pedido. TOTALMENTE
// ISOLADO do gateway do Mercado Livre (routes/webhookGateway.js) e do
// receptor da Shopee: arquivo, rota (/webhooks/tiktok) e fila próprios.
// Mesma disciplina dos outros dois: responde 200 na hora e processa
// assíncrono; aqui, enfileira o MESMO evento padronizado que o polling já
// publica, então handleTiktokOrderEvent (marketplaceEventWorker.js)
// processa igual — só que em tempo real.
//
// Assinatura CONFIRMADA (documentação pública + código-fonte do SDK
// `ecomphp/tiktokshop-php`, ver tiktokClient.js — diferente da assinatura de
// request de negócio): HMAC-SHA256(app_secret, app_key + raw_body), hex
// minúsculo, no header Authorization (SEM prefixo "Bearer"). Sem timestamp
// na assinatura — não há proteção contra replay; a idempotência vem do
// `tts_notification_id` (dedupe por jobId no BullMQ, mesmo padrão da
// Shopee). `type` CONFIRMADO no mesmo SDK: é um CÓDIGO NUMÉRICO, não string
// — 1=ORDER_STATUS_UPDATE (o único tratado nesta fase), 2=REVERSE_ORDER_
// STATUS_UPDATE, 3=RECIPIENT_ADDRESS_UPDATE, 4=PACKAGE_UPDATE, 5=PRODUCT_
// STATUS_UPDATE, 6=SELLER_DEAUTHORIZATION, 7=UPCOMING_AUTHORIZATION_
// EXPIRATION, 12=RETURN_STATUS_UPDATE. Ver .claude/tiktok.md.
const TIKTOK_WEBHOOK_TYPE_ORDER_STATUS_UPDATE = 1;
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');
const { getQueue } = require('../queues/marketplaceEventQueue');
const { publish } = require('../ws/hub');

const router = express.Router();

// GET — teste de conectividade ao cadastrar a URL no Partner Center (evento API).
router.get('/', (req, res) => res.sendStatus(200));

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  res.sendStatus(200); // ack rápido — o TikTok Shop espera 200 imediato

  let payload = {};
  try { payload = JSON.parse(rawBody || '{}'); } catch { payload = {}; }

  try {
    const { appKey, appSecret } = env.tiktok;
    const authHeader = req.get('Authorization') || '';

    let verified = false;
    if (appKey && appSecret && authHeader) {
      const expected = crypto.createHmac('sha256', appSecret).update(`${appKey}${rawBody}`).digest('hex');
      try { verified = crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected)); } catch { verified = false; }
      if (!verified) console.warn(`[tiktok-webhook] assinatura não confere — recebida=${authHeader.slice(0, 20)}… esperada=${expected.slice(0, 20)}…`);
    }

    console.log(`[tiktok-webhook] type=${payload.type} shop=${payload.shop_id} verified=${verified} body=${rawBody.slice(0, 300)}`);

    // Segurança: sem assinatura válida, não processa (a não ser que desligado
    // via TIKTOK_WEBHOOK_VERIFY=false — escape hatch pro 1º teste).
    if (env.tiktok.webhookVerify && appSecret && !verified) return;

    // Só nos interessam eventos de mudança de status de pedido nesta fase
    // (ver .claude/tiktok.md — Fase 1 é só vendas). Outros tipos (produto,
    // endereço, devolução, desautorização...) são ignorados explicitamente.
    if (Number(payload.type) !== TIKTOK_WEBHOOK_TYPE_ORDER_STATUS_UPDATE) return;
    const data = payload.data || {};
    const orderId = data.order_id;
    const shopId = payload.shop_id;
    if (!orderId || !shopId) return;

    const { rows } = await pool.query(`SELECT id FROM stores WHERE tiktok_shop_id = $1`, [String(shopId)]);
    const storeId = rows[0]?.id;
    if (!storeId) { console.warn(`[tiktok-webhook] shop_id ${shopId} sem loja cadastrada — ignorado`); return; }

    // Mesmo jobId do polling → BullMQ deduplica se os dois dispararem pro
    // mesmo pedido (o polling continua como rede de segurança).
    const jobId = `TIKTOK:ORDER_UPDATED:${storeId}-${orderId}`;
    await getQueue('tiktok').add('marketplace-event', {
      marketplace: 'TIKTOK',
      event: 'ORDER_UPDATED',
      resourceId: orderId,
      storeId,
      timestamp: new Date().toISOString(),
    }, { jobId });

    await publish('webhook_received', { topic: 'tiktok_order', resource: orderId, store_id: storeId, status: 'pending' });
  } catch (e) {
    console.error('[tiktok-webhook] erro:', e.message);
  }
});

module.exports = router;
