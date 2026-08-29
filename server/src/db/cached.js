// Helper de cache de leitura sobre Redis — extraído de routes/api.js (v87)
// quando routes/bi.js virou o 2º consumidor (narrativa da IA — cara em
// tokens, não faz sentido regerar a cada clique se nada mudou no período).
// Nunca duplicar esta lógica — ver redis.md.
const redis = require('./redis');

async function cached(key, ttlSeconds, fn) {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const value = await fn();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}

module.exports = { cached };
