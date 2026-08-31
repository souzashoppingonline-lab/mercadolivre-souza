// Monitor de Buy-Box (catálogo) — busca + grava 1 item. Extraído de
// worker.js (job sync-catalog-competition, 04:50 diário) quando ganhou um 2º
// consumidor: a ação pontual de alocar um anúncio no estágio "Catálogo (Buy
// Box)" do Rankeamento (routes/ranking.js) também precisa gravar
// catalog_competition/catalog_competition_history, com a MESMA fórmula —
// nunca duas cópias do upsert. Ver .claude/rankeamento.md e
// .claude/business-rules.md ("Monitor de Buy-Box").
const pool = require('./db/pool');

async function fetchAndSaveCatalogCompetition(ml, itemId, storeId) {
  const ptw = await ml.getPriceToWin(itemId, storeId);
  const boostsMissing = (ptw.boosts || []).filter(b => b.status === 'opportunity').map(b => b.id);

  await pool.query(
    `INSERT INTO catalog_competition (
       store_id, item_id, catalog_product_id, status, current_price, price_to_win,
       winner_item_id, winner_price, boosts_missing, consistent, visit_share, calculated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (item_id) DO UPDATE SET
       store_id=EXCLUDED.store_id, catalog_product_id=EXCLUDED.catalog_product_id,
       status=EXCLUDED.status, current_price=EXCLUDED.current_price, price_to_win=EXCLUDED.price_to_win,
       winner_item_id=EXCLUDED.winner_item_id, winner_price=EXCLUDED.winner_price,
       boosts_missing=EXCLUDED.boosts_missing, consistent=EXCLUDED.consistent,
       visit_share=EXCLUDED.visit_share, calculated_at=now()`,
    [
      storeId, itemId, ptw.catalog_product_id || null, ptw.status || null,
      ptw.current_price ?? null, ptw.price_to_win ?? null,
      ptw.winner?.item_id || null, ptw.winner?.price ?? null,
      boostsMissing, ptw.consistent ?? null, ptw.visit_share || null,
    ]
  );
  await pool.query(
    `INSERT INTO catalog_competition_history (item_id, store_id, status, current_price, price_to_win) VALUES ($1,$2,$3,$4,$5)`,
    [itemId, storeId, ptw.status || null, ptw.current_price ?? null, ptw.price_to_win ?? null]
  );
  return ptw;
}

module.exports = { fetchAndSaveCatalogCompetition };
