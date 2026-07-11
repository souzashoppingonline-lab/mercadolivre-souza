// Fila BullMQ genérica para eventos padronizados de EventSources de
// marketplace (hoje: Amazon). Uma fila por marketplace (`marketplace-events-{code}`),
// mesmo padrão de server/src/queues/webhookQueue.js (fila por loja do ML).
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('../config/env');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

const _queues = new Map();

function getQueue(marketplaceCode) {
  const key = String(marketplaceCode).toLowerCase();
  if (!_queues.has(key)) {
    _queues.set(key, new Queue(`marketplace-events-${key}`, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    }));
  }
  return _queues.get(key);
}

module.exports = { getQueue };
