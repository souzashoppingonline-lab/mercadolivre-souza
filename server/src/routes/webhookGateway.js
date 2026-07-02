// Webhook Gateway — the ONLY entry point that talks to Mercado Livre's push
// notifications. Validates the payload, logs it, and enqueues a BullMQ job.
// Returns 200 immediately (ML requires a fast ack) and does the real work async.
const express = require('express');
const pool = require('../db/pool');
const webhookQueue = require('../queues/webhookQueue');
const { publish } = require('../ws/hub');

const router = express.Router();

router.post('/ml', async (req, res) => {
  const { topic, resource, user_id: storeId, application_id } = req.body || {};

  if (!topic || !resource) {
    return res.status(400).json({ error: 'missing topic/resource' });
  }

  // Ack immediately — Mercado Livre expects a fast 200.
  res.sendStatus(200);

  try {
    const { rows } = await pool.query(
      `INSERT INTO webhook_logs (topic, resource, store_id, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [topic, resource, storeId || null]
    );
    const logId = rows[0].id;

    await webhookQueue.add(topic, { topic, resource, storeId, logId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });

    await publish('webhook_received', { topic, resource, store_id: storeId, status: 'pending' });
  } catch (err) {
    console.error('[webhook-gateway] failed to enqueue', err);
  }
});

// ── Telegram webhook — recebe replies do bot ───────────────
router.post('/telegram', express.json(), async (req, res) => {
  res.sendStatus(200); // ack rápido

  try {
    const msg = req.body?.message;
    if (!msg) return;

    const replyTo = msg.reply_to_message?.message_id;
    const text = msg.text?.trim();
    if (!replyTo || !text) return;

    // Encontra a pergunta pelo tg_message_id armazenado
    const { rows } = await pool.query(
      `SELECT ml_id, store_id FROM questions WHERE tg_message_id=$1 AND status='UNANSWERED' LIMIT 1`,
      [replyTo]
    );
    if (!rows.length) return;

    const { ml_id: questionId, store_id: storeId } = rows[0];
    const ml = require('../mlClient');

    // Chama ML API para responder
    await ml.answerQuestion(questionId, text, storeId);

    // Atualiza DB
    await pool.query(
      `UPDATE questions SET answer_text=$2, status='ANSWERED', updated_at=now() WHERE ml_id=$1`,
      [questionId, text]
    );

    // Confirma no Telegram
    const { rows: cfg } = await pool.query(
      `SELECT key, value FROM app_config WHERE key IN ('telegram_bot_token','telegram_chat_id')`
    );
    const c = Object.fromEntries(cfg.map(r => [r.key, r.value]));
    const token  = c.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = c.telegram_chat_id   || process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          reply_to_message_id: msg.message_id,
          text: `✅ Resposta enviada ao comprador!\n💬 "${text}"`,
          parse_mode: 'HTML'
        })
      });
    }

    publish('question_received', { id: questionId, status: 'ANSWERED' });
  } catch(e) {
    console.error('[tg-webhook]', e.message);
  }
});

module.exports = router;
