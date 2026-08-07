// Backfill único de items.package_dims (medidas da caixa) para os itens que já
// estavam no banco antes da coluna existir (v68). Depois disso, o syncPrecos
// (05:00 diário) mantém tudo atualizado de graça — este script é só pra não
// esperar o 1º ciclo. Ver .claude/embalagem.md.
//
// Uso (no servidor):  node server/scripts/backfillPackageDims.js
//
// Faz getItem em cada anúncio ativo, em lotes com pausa, pra não estourar o
// rate limit do ML (mesma postura dos jobs de sync). NÃO roda no bipe.
const pool = require('../src/db/pool');
const ml = require('../src/mlClient');
const { packageDimsFromItem } = require('../src/mlDims');

const BATCH = 10;       // itens por lote
const PAUSE_MS = 8000;  // pausa entre lotes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { rows: stores } = await pool.query(
    `SELECT id, nickname FROM stores WHERE access_token IS NOT NULL`
  );
  let totalOk = 0, totalDims = 0, totalErr = 0;

  for (const s of stores) {
    const { rows: items } = await pool.query(
      `SELECT ml_id FROM items WHERE store_id=$1 AND status != 'closed'`, [s.id]
    );
    console.log(`[backfill-dims] ${s.nickname}: ${items.length} itens`);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const data = await ml.getItem(it.ml_id, s.id);
        const dims = packageDimsFromItem(data);
        await pool.query(
          `UPDATE items SET package_dims=COALESCE($1::jsonb, package_dims) WHERE ml_id=$2`,
          [dims ? JSON.stringify(dims) : null, it.ml_id]
        );
        totalOk++;
        if (dims) totalDims++;
      } catch (e) {
        console.warn(`[backfill-dims] skip ${it.ml_id}: ${e.message}`);
        totalErr++;
      }
      if ((i + 1) % BATCH === 0 && i + 1 < items.length) {
        console.log(`[backfill-dims] ${s.nickname}: ${i + 1}/${items.length} — pausa ${PAUSE_MS / 1000}s`);
        await sleep(PAUSE_MS);
      }
    }
  }

  console.log(`[backfill-dims] concluído — ${totalOk} itens processados, ${totalDims} com medidas, ${totalErr} erros.`);
  await pool.end();
}

main().catch((e) => {
  console.error('[backfill-dims] falha:', e.message);
  process.exit(1);
});
