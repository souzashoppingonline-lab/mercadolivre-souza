// READ-ONLY, sem API: lê o escrow_raw que já está no banco e mostra TODOS os
// campos de frete do order_income de alguns pedidos Shopee — pra identificar
// qual campo é o "frete que o vendedor paga" antes de trocar a coluna da tela.
//
//   cd /opt/ml-dashboard-novo/server && node test-shopee-frete.js
require('dotenv').config();
const pool = require('./src/db/pool');

(async () => {
  const { rows } = await pool.query(
    `SELECT order_sn, escrow_raw FROM shopee_order_data
      WHERE escrow_raw IS NOT NULL ORDER BY updated_at DESC LIMIT 5`);
  if (!rows.length) { console.log('nenhum escrow gravado'); return pool.end(); }

  for (const r of rows) {
    const inc = r.escrow_raw?.order_income || {};
    console.log(`\n──── ${r.order_sn} ────`);
    console.log(`  buyer_total_amount : ${inc.buyer_total_amount}`);
    console.log(`  commission_fee     : ${inc.commission_fee}`);
    console.log(`  escrow_amount(líq) : ${inc.escrow_amount}`);
    // todos os campos que tenham a ver com frete/logística
    const freteKeys = Object.keys(inc).filter(k => /ship|freight|logistic|rebate|delivery/i.test(k));
    console.log('  --- campos de frete ---');
    for (const k of freteKeys) console.log(`  ${k.padEnd(45)}: ${inc[k]}`);
  }
  console.log('\n  Cole aqui — eu identifico qual campo é o frete que VOCÊ paga e troco a coluna.\n');
  await pool.end();
})();
