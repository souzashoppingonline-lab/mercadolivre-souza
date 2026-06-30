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

module.exports = router;
