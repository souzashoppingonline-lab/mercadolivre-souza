// Passo 1 da Conciliação fase 2: baixa e LÊ um Relatório de Liberações real do
// Mercado Pago (com o token do ML, já confirmado que autentica) e imprime as
// colunas + primeiras linhas + valores distintos de RECORD_TYPE. Objetivo:
// ver o formato REAL antes de escrever o parser/worker (mesma disciplina do
// /collections/:id). Não escreve nada no banco.
//
// Roda em produção: `cd /opt/ml-dashboard-novo/server && node test-mp-report.js`
require('dotenv').config();
const fetch = require('node-fetch');
const pool = require('./src/db/pool');
const XLSX = require('xlsx');

const MP = 'https://api.mercadopago.com';
const get = (path, token) => fetch(`${MP}${path}`, { headers: { Authorization: `Bearer ${token}` } });

async function inspecionar(tipo, store) {
  const t = store.access_token;
  const base = `/v1/account/${tipo}`; // settlement_report | release_report
  let list;
  try {
    const r = await get(`${base}/list`, t);
    if (!r.ok) { console.log(`  ${tipo}/list → HTTP ${r.status} (pula)`); return; }
    list = await r.json();
  } catch (e) { console.log(`  ${tipo}/list erro: ${e.message}`); return; }

  if (!Array.isArray(list) || !list.length) { console.log(`  ${tipo}: nenhum relatório gerado ainda`); return; }

  const rep = list.find(x => x.status === 'processed' || x.status === 'enabled') || list[0];
  console.log(`\n  >>> ${tipo}: ${list.length} relatório(s). Baixando "${rep.file_name}" (status ${rep.status}, ${rep.begin_date?.slice(0,10)}→${rep.end_date?.slice(0,10)})`);

  const dl = await get(`${base}/${rep.file_name}`, t);
  console.log(`      download → HTTP ${dl.status} · content-type: ${dl.headers.get('content-type')}`);
  if (!dl.ok) { console.log(`      corpo: ${(await dl.text()).slice(0, 300)}`); return; }

  const buf = Buffer.from(await dl.arrayBuffer());
  const isXlsx = buf.slice(0, 2).toString('latin1') === 'PK';
  console.log(`      ${buf.length} bytes · formato: ${isXlsx ? 'XLSX' : 'texto/CSV'}`);

  let data;
  if (isXlsx) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  } else {
    data = buf.toString('utf8').split(/\r?\n/).map(l => l.split(/[;,]/));
  }
  if (!data.length) { console.log('      (vazio)'); return; }

  const header = data[0].map(h => String(h));
  console.log(`      linhas: ${data.length} · colunas: ${header.length}`);
  console.log(`      CABEÇALHO: ${JSON.stringify(header)}`);
  console.log('      --- 5 primeiras linhas ---');
  data.slice(1, 6).forEach((row, i) => console.log(`      [${i}] ${JSON.stringify(row)}`));

  // valores distintos das colunas-chave (RECORD_TYPE, DESCRIPTION)
  const up = header.map(h => h.toUpperCase());
  for (const key of ['RECORD_TYPE', 'DESCRIPTION', 'STATUS']) {
    const idx = up.findIndex(h => h.includes(key));
    if (idx >= 0) {
      const vals = [...new Set(data.slice(1).map(r => r[idx]).filter(v => v !== ''))].slice(0, 15);
      console.log(`      distintos de ${header[idx]}: ${JSON.stringify(vals)}`);
    }
  }
}

(async () => {
  const { rows } = await pool.query(
    `SELECT id, nickname, access_token FROM stores
     WHERE (marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL)
     ORDER BY id`
  );
  for (const store of rows) {
    if (!store.access_token) continue;
    console.log(`\n======================= ${store.nickname} (id ${store.id}) =======================`);
    await inspecionar('release_report', store);
    await inspecionar('settlement_report', store);
  }
  console.log('\n--- fim ---');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
