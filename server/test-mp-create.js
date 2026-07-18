// Diagnóstico: qual formato o Mercado Pago aceita pra GERAR um relatório sob
// demanda (RICOPI/TOP_MIX não têm agendado). Testa várias variações de uma vez
// e imprime o status de cada, pra parar de chutar. Cria só pra 1 loja (a 1ª
// sem relatório). Ver conciliacao-bancaria.md.
require('dotenv').config();
const fetch = require('node-fetch');
const pool = require('./src/db/pool');
const MP = 'https://api.mercadopago.com';

async function tryReq(label, method, path, token, body) {
  try {
    const opt = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(`${MP}${path}`, opt);
    const txt = (await res.text()).slice(0, 200);
    console.log(`  [${res.status}] ${label}\n         ${method} ${path}${body !== undefined ? ' body=' + JSON.stringify(body) : ''}\n         ${txt}`);
  } catch (e) { console.log(`  [ERRO] ${label}: ${e.message}`); }
}

(async () => {
  // pega a 1ª loja ML sem relatório de liberação
  const { rows } = await pool.query(
    `SELECT id, nickname, access_token FROM stores
     WHERE (marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL)
       AND access_token IS NOT NULL ORDER BY id`
  );
  let store = null;
  for (const s of rows) {
    const r = await fetch(`${MP}/v1/account/release_report/list`, { headers: { Authorization: `Bearer ${s.access_token}` } });
    const list = await r.json().catch(() => []);
    if (!Array.isArray(list) || !list.length) { store = s; break; }
  }
  if (!store) { console.log('Todas as lojas já têm relatório — nada a testar.'); process.exit(0); }
  const t = store.access_token;
  console.log(`\n=== Testando geração para ${store.nickname} (id ${store.id}) ===\n`);

  const dISO = new Date().toISOString().slice(0, 19) + 'Z';
  const bISO = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19) + 'Z';
  const dDay = new Date().toISOString().slice(0, 10);
  const bDay = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

  console.log('-- release_report --');
  await tryReq('query date-only',  'POST', `/v1/account/release_report?begin_date=${bDay}&end_date=${dDay}`, t);
  await tryReq('query datetime',   'POST', `/v1/account/release_report?begin_date=${bISO}&end_date=${dISO}`, t);
  await tryReq('body date-only',   'POST', `/v1/account/release_report`, t, { begin_date: bDay, end_date: dDay });
  await tryReq('body datetime',    'POST', `/v1/account/release_report`, t, { begin_date: bISO, end_date: dISO });

  console.log('\n-- settlement_report (controle — sabemos que aceita POST) --');
  await tryReq('body datetime',    'POST', `/v1/account/settlement_report`, t, { begin_date: bISO, end_date: dISO });
  await tryReq('query datetime',   'POST', `/v1/account/settlement_report?begin_date=${bISO}&end_date=${dISO}`, t);

  console.log('\n-- release_report config (existe schedule?) --');
  await tryReq('GET config',       'GET',  `/v1/account/release_report/config`, t);

  console.log('\n--- fim ---');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
