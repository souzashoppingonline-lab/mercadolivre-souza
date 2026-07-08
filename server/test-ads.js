require('dotenv').config();
const pool = require('./src/db/pool');
(async () => {
  const { rows } = await pool.query('SELECT id, nickname, access_token FROM stores');
  for (const store of rows) {
    const token = store.access_token;
    if (!token) { console.log(store.nickname, '— sem token'); continue; }
    const sid = store.id;
    const eps = [
      `https://api.mercadolibre.com/advertising/product_ads/advertisers?user_id=${sid}`,
      `https://api.mercadolibre.com/advertising/v2/advertisers?user_id=${sid}`,
      `https://api.mercadolibre.com/users/${sid}/advertising_campaigns?limit=3`,
      `https://api.mercadolibre.com/advertising/advertisers/${sid}`,
    ];
    console.log('=== ' + store.nickname + ' ===');
    for (const url of eps) {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      console.log(res.status, url.replace(sid,'ID').replace('https://api.mercadolibre.com',''), '->', text.slice(0,150));
      if (res.status === 200) break;
    }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
