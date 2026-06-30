const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema applied');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
