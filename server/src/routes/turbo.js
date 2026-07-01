// Vendas ML Turbo — upload e consulta da planilha exportada pelo Mercado Turbo.
// Fonte financeira oficial: substitui reconstruções via API do ML.
// Formato real: sheet "table-pedidos1", 25 colunas conforme MercadoTurbo_Financeiro_*.xlsx
const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const path     = require('path');
const pool     = require('../db/pool');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('Formato inválido. Use .xlsx, .xls ou .csv'));
  },
});

// Normaliza header: lowercase, sem acento, sem parênteses/pontuação extra
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*\([-+=]\)\s*/g, '')  // remove (-), (=), (+) do mercado turbo
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mapeamento: campo interno → aliases normalizados (ordem importa: mais específico primeiro)
const COL_MAP = {
  sale_id:         ['id da venda', 'id venda', 'numero do pedido', 'numero pedido', 'pedido', 'order id', 'n pedido'],
  cart_id:         ['id do carrinho', 'id carrinho', 'carrinho'],
  buyer:           ['nome do comprador', 'comprador', 'buyer', 'nome comprador'],
  state:           ['estado frete', 'estado do comprador', 'estado', 'uf', 'estado destinatario'],
  item_code:       ['codigo do anuncio', 'cod anuncio', 'codigo anuncio', 'codigo', 'item id', 'mlb', 'id anuncio'],
  title:           ['titulo do anuncio', 'nome do anuncio', 'anuncio', 'titulo', 'title', 'nome do produto', 'produto', 'descricao'],
  account:         ['conta do vendedor', 'conta', 'loja', 'seller', 'vendedor'],
  shipping_mode:   ['modalidade de entrega', 'modalidade de frete', 'modalidade', 'tipo de envio'],
  ads:             ['publicidade', 'ads', 'custo publicidade', 'anuncios'],
  sku:             ['sku', 'codigo interno', 'cod interno'],
  sale_date:       ['data da venda', 'data da compra', 'data pedido', 'data', 'data do pedido'],
  shipping_type:   ['tipo de frete', 'tipo frete', 'frete tipo', 'entrega'],
  unit_price:      ['valor unitario', 'preco unitario', 'valor unit', 'preco unit', 'preco', 'valor'],
  quantity:        ['quantidade', 'qtd', 'qty', 'unidades'],
  revenue:         ['faturamento ml', 'faturamento bruto', 'faturamento', 'receita', 'gmv', 'total'],
  cost:            ['custo do produto', 'custo', 'cogs', 'cmv', 'custo unitario'],
  tax:             ['imposto', 'impostos', 'taxa imposto'],
  ml_fee:          ['tarifa de venda', 'tarifa ml', 'taxa ml', 'taxa de venda', 'tarifa', 'comissao ml'],
  buyer_shipping:  ['frete pago pelo comprador', 'frete comprador', 'valor frete comprador'],
  seller_shipping: ['frete pago pelo vendedor', 'frete vendedor', 'valor frete vendedor', 'custo frete'],
  margin:          ['margem de contribuicao', 'margem contrib', 'margem contribuicao', 'mc r'],
  margin_pct:      ['margem de contribuicao em', 'mc em', 'margem em', 'mc %', '% margem', 'margem pct', 'margem  em'],
  order_status:    ['status do pedido', 'status pedido', 'situacao do pedido', 'situacao', 'status'],
  payment_status:  ['status do pagamento', 'status pagamento', 'pagamentos', 'pagamento'],
  shipping_id:     ['id do frete', 'id frete', 'shipping id', 'codigo frete'],
};

function detectColumns(headers) {
  const normed = headers.map(h => norm(h));
  const map = {};
  for (const [field, aliases] of Object.entries(COL_MAP)) {
    // 1) exact match
    let idx = normed.findIndex(h => aliases.some(a => h === a));
    // 2) starts-with match
    if (idx === -1) idx = normed.findIndex(h => aliases.some(a => h.startsWith(a)));
    // 3) includes match
    if (idx === -1) idx = normed.findIndex(h => aliases.some(a => h.includes(a)));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[R$\s%]/g, '').replace(/\./g, '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parsePct(v) {
  // "29.26%" → 29.26
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace('%', '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    // Excel date serial
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ── POST /turbo/import ─────────────────────────────────────
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    return res.status(400).json({ error: 'Arquivo inválido: ' + e.message });
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) return res.status(400).json({ error: 'Planilha vazia ou sem dados' });

  // Auto-detect header row: ML Turbo sometimes has title/date rows before the headers.
  // Find the row with the most COL_MAP matches (max scan: first 5 rows).
  let headerRowIdx = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const candidate = rows[r].map(String);
    const score = Object.keys(detectColumns(candidate)).length;
    if (score > bestScore) { bestScore = score; headerRowIdx = r; }
  }

  const headers = rows[headerRowIdx].map(String);
  const dataRows = rows.slice(headerRowIdx + 1);
  const colMap  = detectColumns(headers);
  console.log(`[turbo] header row=${headerRowIdx} score=${bestScore}`, headers.map((h, i) => `${i}:"${h}"`).join(' | '));
  console.log('[turbo] mapeamento:', Object.entries(colMap).map(([k,v]) => `${k}=${headers[v]}`).join(', '));

  if (colMap.sale_id == null) {
    const normed = headers.map(h => norm(h));
    return res.status(400).json({
      error: 'Coluna "ID da Venda" não encontrada. Verifique se é uma planilha do Mercado Turbo.',
      headers_detected: headers,
      headers_normed: normed,
      header_row_used: headerRowIdx,
      tip: 'Colunas esperadas: "ID da Venda", "Número do Pedido" ou similar',
    });
  }

  const stats = { inserted: 0, updated: 0, skipped: 0, errors: 0, error_details: [] };
  const get   = (row, field) => colMap[field] != null ? row[colMap[field]] : null;

  for (let i = 0; i < dataRows.length; i++) {
    const row    = dataRows[i];
    const rawId  = String(get(row, 'sale_id') || '').trim();
    const saleId = rawId.replace(/^#/, '');   // strip leading # if present
    if (!saleId || saleId === '0') { stats.skipped++; continue; }

    try {
      const result = await pool.query(
        `INSERT INTO ml_turbo_sales
           (sale_id,cart_id,buyer,state,item_code,title,account,shipping_mode,ads,sku,
            sale_date,shipping_type,unit_price,quantity,revenue,cost,tax,ml_fee,
            buyer_shipping,seller_shipping,margin,margin_pct,order_status,payment_status,shipping_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT (sale_id) DO UPDATE SET
           cart_id=EXCLUDED.cart_id, buyer=EXCLUDED.buyer, state=EXCLUDED.state,
           item_code=EXCLUDED.item_code, title=EXCLUDED.title, account=EXCLUDED.account,
           shipping_mode=EXCLUDED.shipping_mode, ads=EXCLUDED.ads, sku=EXCLUDED.sku,
           sale_date=EXCLUDED.sale_date, shipping_type=EXCLUDED.shipping_type,
           unit_price=EXCLUDED.unit_price, quantity=EXCLUDED.quantity, revenue=EXCLUDED.revenue,
           cost=EXCLUDED.cost, tax=EXCLUDED.tax, ml_fee=EXCLUDED.ml_fee,
           buyer_shipping=EXCLUDED.buyer_shipping, seller_shipping=EXCLUDED.seller_shipping,
           margin=EXCLUDED.margin, margin_pct=EXCLUDED.margin_pct,
           order_status=EXCLUDED.order_status, payment_status=EXCLUDED.payment_status,
           shipping_id=EXCLUDED.shipping_id, updated_at=now()
         RETURNING (xmax = 0) AS inserted`,
        [
          saleId,
          String(get(row, 'cart_id')       || '').trim().replace(/^#/, '') || null,
          String(get(row, 'buyer')         || '').trim() || null,
          String(get(row, 'state')         || '').trim() || null,
          String(get(row, 'item_code')     || '').trim() || null,
          String(get(row, 'title')         || '').trim() || null,
          String(get(row, 'account')       || '').trim() || null,
          String(get(row, 'shipping_mode') || '').trim() || null,
          parseNum(get(row, 'ads')),
          String(get(row, 'sku')           || '').trim() || null,
          parseDate(get(row, 'sale_date')),
          String(get(row, 'shipping_type') || '').trim() || null,
          parseNum(get(row, 'unit_price')),
          parseInt(get(row, 'quantity')) || 1,
          parseNum(get(row, 'revenue')),
          parseNum(get(row, 'cost')),
          parseNum(get(row, 'tax')),
          parseNum(get(row, 'ml_fee')),
          parseNum(get(row, 'buyer_shipping')),
          parseNum(get(row, 'seller_shipping')),
          parseNum(get(row, 'margin')),
          parsePct(get(row, 'margin_pct')),
          String(get(row, 'order_status')   || '').trim() || null,
          String(get(row, 'payment_status') || '').trim() || null,
          String(get(row, 'shipping_id')    || '').trim() || null,
        ]
      );
      if (result.rows[0].inserted) stats.inserted++;
      else stats.updated++;
    } catch (e) {
      stats.errors++;
      if (stats.error_details.length < 10) {
        stats.error_details.push({ row: i + 1, sale_id: saleId, error: e.message });
      }
    }
  }

  res.json({
    ok: true,
    file: req.file.originalname,
    sheet: sheetName,
    total_rows: dataRows.length,
    ...stats,
  });
});

// ── GET /turbo/kpis ────────────────────────────────────────
router.get('/kpis', async (req, res) => {
  const { date_from = '', date_to = '', account = '', sku = '', state = '', order_status = '' } = req.query;
  const f = buildFilters({ date_from, date_to, account, sku, state, order_status });
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                                       AS total_vendas,
       COALESCE(SUM(quantity),0)                      AS total_qty,
       COALESCE(SUM(revenue),0)                       AS receita,
       COALESCE(SUM(cost),0)                          AS cmv,
       COALESCE(SUM(tax),0)                           AS impostos,
       COALESCE(SUM(ml_fee),0)                        AS tarifas,
       COALESCE(SUM(buyer_shipping),0)                AS frete_comprador,
       COALESCE(SUM(seller_shipping),0)               AS frete_vendedor,
       COALESCE(SUM(ads),0)                           AS total_ads,
       COALESCE(SUM(margin),0)                        AS lucro,
       CASE WHEN SUM(revenue)>0
            THEN ROUND(SUM(margin)/SUM(revenue)*100,2)
            ELSE 0 END                                AS margem_pct
     FROM ml_turbo_sales WHERE ${f.where}`,
    f.params
  );
  res.json(rows[0] || {});
});

// ── GET /turbo/sales ───────────────────────────────────────
router.get('/sales', async (req, res) => {
  const { date_from='', date_to='', account='', sku='', item_code='',
          state='', shipping_mode='', order_status='', page=1, limit=100 } = req.query;
  const f = buildFilters({ date_from, date_to, account, sku, item_code, state, shipping_mode, order_status });
  const offset = (Number(page) - 1) * Number(limit);

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT * FROM ml_turbo_sales WHERE ${f.where}
       ORDER BY sale_date DESC NULLS LAST, id DESC
       LIMIT $${f.params.length + 1} OFFSET $${f.params.length + 2}`,
      [...f.params, Number(limit), offset]
    ),
    pool.query(`SELECT COUNT(*) FROM ml_turbo_sales WHERE ${f.where}`, f.params),
  ]);

  res.json({ sales: data.rows, total: Number(count.rows[0].count), page: Number(page), limit: Number(limit) });
});

// ── GET /turbo/charts ──────────────────────────────────────
router.get('/charts', async (req, res) => {
  const { date_from='', date_to='', account='', order_status='' } = req.query;
  const f = buildFilters({ date_from, date_to, account, order_status });

  const [daily, byState, byAccount, topRevenue, topMargin, lowMargin, byShipping] = await Promise.all([
    pool.query(
      `SELECT sale_date::date as date,
              SUM(revenue) revenue, SUM(margin) lucro, COUNT(*) vendas,
              CASE WHEN SUM(revenue)>0 THEN SUM(margin)/SUM(revenue)*100 ELSE 0 END margem_pct
       FROM ml_turbo_sales WHERE ${f.where}
       GROUP BY 1 ORDER BY 1`,
      f.params
    ),
    pool.query(
      `SELECT state, SUM(revenue) revenue, SUM(margin) lucro, COUNT(*) vendas
       FROM ml_turbo_sales WHERE ${f.where} AND state IS NOT NULL
       GROUP BY state ORDER BY revenue DESC LIMIT 20`,
      f.params
    ),
    pool.query(
      `SELECT account, SUM(revenue) revenue, SUM(margin) lucro,
              COUNT(*) vendas, CASE WHEN SUM(revenue)>0 THEN SUM(margin)/SUM(revenue)*100 ELSE 0 END margem_pct
       FROM ml_turbo_sales WHERE ${f.where} AND account IS NOT NULL
       GROUP BY account ORDER BY revenue DESC`,
      f.params
    ),
    pool.query(
      `SELECT item_code, title, SUM(revenue) revenue, SUM(quantity) qty
       FROM ml_turbo_sales WHERE ${f.where} AND item_code IS NOT NULL
       GROUP BY item_code, title ORDER BY revenue DESC LIMIT 10`,
      f.params
    ),
    pool.query(
      `SELECT item_code, title, SUM(margin) lucro, SUM(quantity) qty
       FROM ml_turbo_sales WHERE ${f.where} AND item_code IS NOT NULL
       GROUP BY item_code, title ORDER BY lucro DESC LIMIT 10`,
      f.params
    ),
    pool.query(
      `SELECT item_code, title,
              CASE WHEN SUM(revenue)>0 THEN ROUND(SUM(margin)/SUM(revenue)*100,2) ELSE 0 END AS margem_pct,
              SUM(revenue) revenue, SUM(quantity) qty
       FROM ml_turbo_sales WHERE ${f.where} AND item_code IS NOT NULL AND revenue > 50
       GROUP BY item_code, title HAVING SUM(quantity) >= 3
       ORDER BY margem_pct ASC LIMIT 10`,
      f.params
    ),
    pool.query(
      `SELECT shipping_type, COUNT(*) vendas, SUM(revenue) revenue
       FROM ml_turbo_sales WHERE ${f.where} AND shipping_type IS NOT NULL
       GROUP BY shipping_type ORDER BY vendas DESC`,
      f.params
    ),
  ]);

  res.json({
    daily:       daily.rows,
    by_state:    byState.rows,
    by_account:  byAccount.rows,
    top_revenue: topRevenue.rows,
    top_margin:  topMargin.rows,
    low_margin:  lowMargin.rows,
    by_shipping: byShipping.rows,
  });
});

// ── GET /turbo/filters-meta ────────────────────────────────
router.get('/filters-meta', async (req, res) => {
  const [accounts, states, statuses, modes] = await Promise.all([
    pool.query(`SELECT DISTINCT account FROM ml_turbo_sales WHERE account IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT state   FROM ml_turbo_sales WHERE state   IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT order_status FROM ml_turbo_sales WHERE order_status IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT shipping_mode FROM ml_turbo_sales WHERE shipping_mode IS NOT NULL ORDER BY 1`),
  ]);
  res.json({
    accounts:       accounts.rows.map(r => r.account),
    states:         states.rows.map(r => r.state),
    order_statuses: statuses.rows.map(r => r.order_status),
    shipping_modes: modes.rows.map(r => r.shipping_mode),
  });
});

// ── Helper: build WHERE clause ─────────────────────────────
function buildFilters(f) {
  const conds = [], params = [];
  const add = (cond, val) => { params.push(val); conds.push(cond.replace('?', `$${params.length}`)); };

  if (f.date_from)     add(`sale_date >= ?::date`,    f.date_from);
  if (f.date_to)       add(`sale_date <= ?::date`,    f.date_to);
  if (f.account)       add(`account = ?`,             f.account);
  if (f.sku)           add(`sku ILIKE ?`,             `%${f.sku}%`);
  if (f.item_code)     add(`item_code ILIKE ?`,       `%${f.item_code}%`);
  if (f.state)         add(`state = ?`,               f.state);
  if (f.shipping_mode) add(`shipping_mode = ?`,       f.shipping_mode);
  if (f.order_status)  add(`order_status ILIKE ?`,    `%${f.order_status}%`);

  return { where: conds.length ? conds.join(' AND ') : '1=1', params };
}

module.exports = router;
