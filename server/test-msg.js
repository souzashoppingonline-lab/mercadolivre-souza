// Descartável: dump da resposta crua de /messages/{id} pra mapear os campos
// reais (texto, comprador) da mensagem ML. Ver worker.js handleMessage.
//   node test-msg.js <msgId> <storeId>
// Ex.: node test-msg.js 019f89d4ee8570a38ab7ac280a363d01 1662123376
require('dotenv').config();
const ml = require('./src/mlClient');

(async () => {
  const [msgId, storeId] = process.argv.slice(2);
  if (!msgId || !storeId) {
    console.error('uso: node test-msg.js <msgId> <storeId>');
    process.exit(1);
  }
  try {
    const msg = await ml.getMessage(msgId, storeId);
    console.log('KEYS:', Object.keys(msg || {}));
    console.log(JSON.stringify(msg, null, 2));
  } catch (e) {
    console.error('ERRO:', e.message);
  }
  process.exit(0);
})();
