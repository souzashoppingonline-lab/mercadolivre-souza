#!/bin/bash
# Dispara dailySync manualmente (visitas, reputação, pedidos)
cd "$(dirname "$0")"
node -e "
const IORedis = require('ioredis');
const r = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
r.publish('worker:cmd', JSON.stringify({cmd:'dailySync'})).then(() => {
  console.log('[sync] dailySync disparado — acompanhe: journalctl -u ml-worker-novo -f');
  r.quit();
});
"
