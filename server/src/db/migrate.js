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
    'migrate-v12.sql',
    'migrate-v13.sql',
    'migrate-v14.sql',
    'migrate-v15.sql',
    'migrate-v16.sql',
    'migrate-v17.sql',
    'migrate-v18.sql',
    'migrate-v19.sql',
    'migrate-v20.sql',
    'migrate-v21.sql',
    'migrate-v22.sql',
    'migrate-v23.sql',
    'migrate-v24.sql',
    'migrate-v25.sql',
    'migrate-v26.sql',
    'migrate-v27.sql',
    'migrate-v28.sql',
    'migrate-v29.sql',
    'migrate-v30.sql',
    'migrate-v31.sql',
    'migrate-v32.sql',
    'migrate-v33.sql',
    'migrate-v34.sql',
    'migrate-v35.sql',
    'migrate-v36.sql',
    'migrate-v37.sql',
    'migrate-v38.sql',
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
