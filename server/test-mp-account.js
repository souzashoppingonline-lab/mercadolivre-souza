// Diagnóstico READ-ONLY: o token OAuth do Mercado Livre autentica no domínio
// do Mercado Pago (api.mercadopago.com)? Se sim, dá pra confirmar a etapa 4
// (transferência bancária / dinheiro na conta) sem app MP separado — mesma
// lógica da descoberta do /collections/:id.
//
// Só faz GET (nenhum POST, não cria relatório, não escreve nada). Roda em
// produção: `cd /opt/ml-dashboard-novo/server && node test-mp-account.js`.
require('dotenv').config();
const fetch = require('node-fetch');
const pool = require('./src/db/pool');

async function probe(label, url, token) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.text();
    const short = body.length > 500 ? body.slice(0, 500) + '…' : body;
    console.log(`\n  [${res.status}] ${label}`);
    console.log(`       ${url}`);
    console.log(`       ${short.replace(/\n/g, ' ')}`);
  } catch (e) {
    console.log(`\n  [ERRO] ${label} — ${e.message}`);
  }
}

(async () => {
  const { rows } = await pool.query(
    `SELECT id, nickname, access_token FROM stores
     WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL`
  );
  for (const store of rows) {
    if (!store.access_token) { console.log(`\n=== ${store.nickname} — sem token ===`); continue; }
    const t = store.access_token;
    console.log(`\n======================= ${store.nickname} (id ${store.id}) =======================`);

    // Baseline: confirma que o token é válido e pega o user_id real
    await probe('ML /users/me (baseline, deve dar 200)', 'https://api.mercadolibre.com/users/me', t);

    // Mercado Pago — relatórios de conciliação (config/list são GET read-only)
    await probe('MP settlement_report/config', 'https://api.mercadopago.com/v1/account/settlement_report/config', t);
    await probe('MP settlement_report/list',   'https://api.mercadopago.com/v1/account/settlement_report/list', t);
    await probe('MP release_report/config',    'https://api.mercadopago.com/v1/account/release_report/config', t);
    await probe('MP release_report/list',      'https://api.mercadopago.com/v1/account/release_report/list', t);

    // Saldo da conta MP (user_id = stores.id, que é o id do vendedor no ML)
    await probe('MP saldo da conta', `https://api.mercadopago.com/v1/users/${store.id}/mercadopago_account/balance`, t);
  }
  console.log('\n--- fim ---');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
