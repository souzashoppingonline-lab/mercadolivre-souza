const Redis = require('ioredis');
const env = require('../config/env');

const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

redis.on('error', (err) => console.error('[redis] error', err));

module.exports = redis;
