// Preenche item_id nos pedidos antigos que ficaram NULL
// Faz o match pelo título entre orders e items da mesma loja
// Roda uma vez só: node src/db/fix-orders-item-id.js
require('dotenv').config();
const pool = require('./pool');

(async () => {
  // Quantos pedidos sem item_id existem
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*) as total FROM orders WHERE item_id IS NULL`
  );
  console.log(`[fix] ${total} pedidos sem item_id`);
  if (Number(total) === 0) { console.log('[fix] nada a fazer'); await pool.end(); return; }

  // Atualiza em lote: busca item_id pelo título exato dentro da mesma loja
  const { rowCount } = await pool.query(`
    UPDATE orders o
    SET item_id = i.ml_id, updated_at = now()
    FROM items i
    WHERE o.item_id IS NULL
      AND o.store_id = i.store_id
      AND o.title = i.title
  `);
  console.log(`[fix] ${rowCount} pedidos atualizados com item_id pelo título exato`);

  // Segunda passagem: título similar (ILIKE) para variações de capitalização
  const { rowCount: rowCount2 } = await pool.query(`
    UPDATE orders o
    SET item_id = i.ml_id, updated_at = now()
    FROM items i
    WHERE o.item_id IS NULL
      AND o.store_id = i.store_id
      AND LOWER(o.title) = LOWER(i.title)
  `);
  console.log(`[fix] ${rowCount2} pedidos adicionais atualizados (case insensitive)`);

  // Quantos ainda sem item_id
  const { rows: [{ restantes }] } = await pool.query(
    `SELECT COUNT(*) as restantes FROM orders WHERE item_id IS NULL`
  );
  console.log(`[fix] ${restantes} pedidos ainda sem item_id (itens removidos do ML ou título divergente)`);

  await pool.end();
  console.log('[fix] concluído');
})().catch(e => { console.error(e.message); process.exit(1); });
