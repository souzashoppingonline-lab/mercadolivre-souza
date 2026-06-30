const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('../config/env');

const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

const webhookQueue = new Queue('ml-webhooks', { connection });

module.exports = webhookQueue;
