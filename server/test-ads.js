require('dotenv').config();
const pool = require('./src/db/pool');
(async () => {
  const { rows } = await pool.query('SELECT id, nickname, access_token FROM stores');
  for (const store of rows) {
    const token = store.access_token;
    if (!token) { console.log(store.nickname, '— sem token'); continue; }
    const res = await fetch('https://api.mercadolibre.com/advertising/product_ads/advertisers', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const text = await res.text();
    console.log('---', store.nickname, 'HTTP', res.status, '---');
    console.log(text.slice(0, 400));
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
