require('dotenv').config();
const pool = require('./src/db/pool');
(async () => {
  const { rows } = await pool.query('SELECT id, nickname, access_token FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code=\'ML\') OR marketplace_id IS NULL');
  for (const store of rows) {
    const token = store.access_token;
    if (!token) { console.log(store.nickname, '— sem token'); continue; }
    console.log('=== ' + store.nickname + ' (' + store.id + ') ===');
    for (const group of ['MP', 'ML']) {
      const url = `https://api.mercadolibre.com/billing/integration/monthly/periods?group=${group}&document_type=BILL&limit=3`;
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      console.log(res.status, `group=${group}`, '->', text.slice(0, 800));
    }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
