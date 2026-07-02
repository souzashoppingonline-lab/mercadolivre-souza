const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('../config/env');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

const _queues = new Map();

function getQueue(storeId) {
  const key = String(storeId || 'default');
  if (!_queues.has(key)) {
    _queues.set(key, new Queue(`ml-webhooks-${key}`, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    }));
  }
  return _queues.get(key);
}

// Backward compat — fila padrão para jobs sem storeId
const webhookQueue = getQueue('default');

module.exports = { webhookQueue, getQueue };
