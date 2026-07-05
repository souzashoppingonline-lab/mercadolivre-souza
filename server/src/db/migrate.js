const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const files = [
    'schema.sql',
    'migrate-v2.sql',
    'migrate-v3.sql',
    'migrate-v4.sql',
    'migrate-v8.sql',
    'migrate-v9.sql',
    'migrate-v11.sql',
  ];
  for (const f of files) {
    const filePath = path.join(__dirname, f);
    if (!fs.existsSync(filePath)) { console.log(`[migrate] skip ${f} (not found)`); continue; }
    const sql = fs.readFileSync(filePath, 'utf8');
    await pool.query(sql);
    console.log(`[migrate] applied ${f}`);
  }
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
