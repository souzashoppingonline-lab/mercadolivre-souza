// Conciliação Bancária fase 2 — baixa os Relatórios de Liberação do Mercado
// Pago (release_report) com o token do ML, parseia o XLSX e grava cada linha
// (movimento da conta) em `mp_account_movements`, casada por source_id
// (payment) / order_id. Módulo puro (sem BullMQ) — o worker.js só o agenda.
// Formato do relatório confirmado ao vivo (test-mp-report.js) — ver decisions.md.
const XLSX = require('xlsx');
const crypto = require('crypto');
const pool = require('./db/pool');
const ml = require('./mlClient');

const REPORT_TYPE = 'release_report';       // tem o extrato + saques (Cash withdrawal) + BALANCE
const MAX_FILES_PER_RUN = 3;                 // não baixa os 67 de uma vez; converge em algumas execuções

const num = (v) => {
  if (v === '' || v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
};

// Mapeia UMA linha do release_report (array) para o objeto de movimento,
// usando o índice das colunas por nome (o relatório tem 46 colunas em ordem
// que pode variar entre versões — nunca dependemos de índice fixo).
function parseRow(header, row, storeId, fileName) {
  const at = (name) => { const i = header.indexOf(name); return i >= 0 ? row[i] : ''; };
  const release_date = at('RELEASE_DATE') || null;
  const source_id = String(at('SOURCE_ID') || '').trim();
  const description = String(at('DESCRIPTION') || '').trim();
  const net_credit = num(at('NET_CREDIT_AMOUNT'));
  const net_debit = num(at('NET_DEBIT_AMOUNT'));
  const balance = at('BALANCE') === '' ? null : num(at('BALANCE'));
  // Hash de dedup — relatórios com range sobreposto trazem o mesmo movimento;
  // balance no hash torna cada linha praticamente única (saldo acumulado).
  const movement_hash = crypto.createHash('md5')
    .update(`${storeId}|${source_id}|${description}|${release_date}|${net_credit}|${net_debit}|${balance}`)
    .digest('hex');
  return {
    store_id: storeId, movement_hash, release_date, source_id,
    order_id: String(at('ORDER_ID') || at('EXTERNAL_REFERENCE') || '').trim() || null,
    pack_id: String(at('PACK_ID') || '').trim() || null,
    shipping_id: String(at('SHIPPING_ID') || '').trim() || null,
    record_type: String(at('RECORD_TYPE') || '').trim() || null,
    description: description || null,
    net_credit_amount: net_credit, net_debit_amount: net_debit,
    gross_amount: num(at('GROSS_AMOUNT')), mp_fee_amount: num(at('MP_FEE_AMOUNT')),
    shipping_fee_amount: num(at('SHIPPING_FEE_AMOUNT')), coupon_amount: num(at('COUPON_AMOUNT')),
    balance, payment_method: String(at('PAYMENT_METHOD') || '').trim() || null,
    sale_detail: String(at('SALE_DETAIL') || '').trim().replace(/^"+|"+$/g, '') || null,
    report_file: fileName,
  };
}

async function insertMovements(rows) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals = [];
    const ph = chunk.map((r, k) => {
      const b = k * 18;
      vals.push(r.store_id, r.movement_hash, r.release_date, r.source_id, r.order_id, r.pack_id,
        r.shipping_id, r.record_type, r.description, r.net_credit_amount, r.net_debit_amount,
        r.gross_amount, r.mp_fee_amount, r.shipping_fee_amount, r.coupon_amount, r.balance,
        r.payment_method, r.sale_detail);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`;
    }).join(',');
    const res = await pool.query(
      `INSERT INTO mp_account_movements
        (store_id, movement_hash, release_date, source_id, order_id, pack_id, shipping_id,
         record_type, description, net_credit_amount, net_debit_amount, gross_amount,
         mp_fee_amount, shipping_fee_amount, coupon_amount, balance, payment_method, sale_detail)
       VALUES ${ph}
       ON CONFLICT (movement_hash) DO NOTHING`,
      vals
    );
    inserted += res.rowCount;
  }
  return inserted;
}

async function importFile(storeId, fileName) {
  const buf = await ml.downloadMpReport(REPORT_TYPE, fileName, storeId);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (data.length < 2) return { rows: 0, inserted: 0 };
  const header = data[0].map((h) => String(h).trim());
  const movimentos = data.slice(1)
    .filter((r) => r.some((c) => c !== '') && String(r[header.indexOf('RECORD_TYPE')] || '').trim() !== 'Total')
    .map((r) => parseRow(header, r, storeId, fileName));
  const inserted = await insertMovements(movimentos);
  await pool.query(
    `INSERT INTO mp_reports_imported (store_id, report_type, file_name, row_count)
     VALUES ($1, $2, $3, $4) ON CONFLICT (store_id, file_name) DO NOTHING`,
    [storeId, REPORT_TYPE, fileName, movimentos.length]
  );
  return { rows: movimentos.length, inserted };
}

// Ponto de entrada — chamado pelo worker (agendado) e pela rota de trigger.
async function syncMpAccountReports() {
  const { rows: stores } = await pool.query(
    `SELECT id, nickname, access_token FROM stores
     WHERE (marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL)
       AND access_token IS NOT NULL`
  );
  let totalInserted = 0;
  for (const store of stores) {
    try {
      const list = await ml.getMpReportList(REPORT_TYPE, store.id);
      if (!Array.isArray(list) || !list.length) {
        // Conta sem relatório agendado (ex: RICOPI/TOP_MIX) — gera 1 sob demanda
        // pros últimos 60 dias; nas próximas execuções ele já é baixado.
        const end = new Date().toISOString().slice(0, 19) + 'Z';
        const begin = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 19) + 'Z';
        await ml.createMpReport(REPORT_TYPE, store.id, begin, end)
          .then(() => console.log(`[mp-reports] ${store.nickname}: sem relatório — gerado 1 sob demanda`))
          .catch((e) => console.warn(`[mp-reports] ${store.nickname}: create falhou: ${e.message}`));
        continue;
      }
      // Só arquivos processados e ainda não importados, mais novos primeiro
      const { rows: imported } = await pool.query(
        `SELECT file_name FROM mp_reports_imported WHERE store_id = $1`, [store.id]
      );
      const done = new Set(imported.map((r) => r.file_name));
      const pending = list
        .filter((x) => (x.status === 'processed' || x.status === 'enabled') && !done.has(x.file_name))
        .sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)))
        .slice(0, MAX_FILES_PER_RUN);
      for (const rep of pending) {
        const { rows, inserted } = await importFile(store.id, rep.file_name);
        totalInserted += inserted;
        console.log(`[mp-reports] ${store.nickname}: ${rep.file_name} — ${rows} linhas, ${inserted} novas`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      console.error(`[mp-reports] ${store.nickname}: erro — ${e.message}`);
    }
  }
  console.log(`[mp-reports] concluído: ${totalInserted} movimentos novos no total`);
  return { inserted: totalInserted };
}

module.exports = { syncMpAccountReports, parseRow };
