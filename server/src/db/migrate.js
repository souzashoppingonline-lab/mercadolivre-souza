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
    'migrate-v39.sql',
    'migrate-v40.sql',
    'migrate-v41.sql',
    'migrate-v42.sql',
    'migrate-v43.sql',
    'migrate-v44.sql',
    'migrate-v45.sql',
    'migrate-v46.sql',
    'migrate-v47.sql',
    'migrate-v48.sql',
    'migrate-v49.sql',
    'migrate-v50.sql',
    'migrate-v51.sql',
    'migrate-v52.sql',
    'migrate-v53.sql',
    'migrate-v54.sql',
    'migrate-v55.sql',
    'migrate-v56.sql',
    'migrate-v57.sql',
    'migrate-v58.sql',
    'migrate-v59.sql',
    'migrate-v60.sql',
    'migrate-v61.sql',
    'migrate-v62.sql',
    'migrate-v63.sql',
    'migrate-v64.sql',
    'migrate-v65.sql',
    'migrate-v66.sql',
    'migrate-v67.sql',
    'migrate-v68.sql',
    'migrate-v69.sql',
    'migrate-v70.sql',
    'migrate-v71.sql',
    'migrate-v72.sql',
    'migrate-v73.sql',
    'migrate-v74.sql',
    'migrate-v75.sql',
    'migrate-v76.sql',
  ];
  // Cada arquivo roda ISOLADO: se um falhar (ex.: migration antiga não
  // idempotente), loga e CONTINUA — antes um erro abortava tudo (process.exit),
  // e as migrations seguintes nunca rodavam, causando drift de schema (ex.: a
  // coluna `descricao` de analise_product_ads que nunca era criada). Como as
  // migrations usam ADD COLUMN/CREATE ... IF NOT EXISTS, reexecutar é seguro.
  let ok = 0, fail = 0;
  for (const f of files) {
    const filePath = path.join(__dirname, f);
    if (!fs.existsSync(filePath)) { console.log(`[migrate] skip ${f} (not found)`); continue; }
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      console.log(`[migrate] applied ${f}`);
      ok++;
    } catch (e) {
      console.error(`[migrate] ERRO em ${f} (continuando): ${e.message}`);
      fail++;
    }
  }
  console.log(`[migrate] concluído — ${ok} ok, ${fail} com erro`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] falha fatal (conexão?):', err.message);
  process.exit(1);
});
