const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('../config/env');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

const webhookQueue = new Queue('ml-webhooks', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 }, // retry: 10s, 20s, 40s, 80s, 160s
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

module.exports = webhookQueue;
