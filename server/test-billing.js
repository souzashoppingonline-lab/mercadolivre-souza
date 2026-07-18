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
      const json = await res.json().catch(() => null);
      console.log(res.status, `group=${group} periods`, '->', JSON.stringify(json)?.slice(0, 800));

      const closed = json?.results?.find(r => r.period_status === 'CLOSED');
      if (!closed) { console.log('  (sem período CLOSED pra testar /details)'); continue; }
      const detailsUrl = `https://api.mercadolibre.com/billing/integration/periods/key/${closed.key}/group/${group}/details?document_type=BILL&limit=5`;
      const detRes = await fetch(detailsUrl, { headers: { Authorization: 'Bearer ' + token } });
      const detText = await detRes.text();
      console.log(detRes.status, `group=${group} details (key=${closed.key})`, '->', detText.slice(0, 1000));
    }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
