// Importador Metrizap — fonte de "Vendas e Custos" (pages/vendas.html), no
// lugar do Mercado Turbo (pedido explícito do usuário — ver .claude/finance.md).
// Multi-empresa: a conta/empresa é escolhida no dropdown ANTES do upload
// (não inferida só da coluna "Conta" da planilha), porque o projeto já está
// expandindo para TikTok Shop e Amazon e o formato de export de cada
// marketplace pode não trazer essa coluna de forma consistente.
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const pool    = require('../db/pool');

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

const HEADERS = {
  data:         'Data',
  marketplace:  'Marketplace',
  conta:        'Conta',
  pedido:       'Pedido',
  pacote:       'Pacote / envio conjunto',
  item_id:      'ID do anúncio',
  sku:          'SKU',
  produto:      'Produto',
  quantidade:   'Quantidade',
  situacao:     'Situação',
  status_mkt:   'Status no marketplace',
  afiliado:     'Venda de afiliado',
  comissao:     'Comissão de afiliado',
  logistica:    'Logística',
  comprador:    'Comprador',
  valor_pago:   'Valor pago pelo comprador',
  faturamento:  'Faturamento',
  tarifa:       'Tarifa',
  frete_vend:   'Frete vendedor',
  frete_comp:   'Frete comprador',
  imposto:      'Imposto',
  custo:        'Custo do produto',
  prejuizo:     'Prejuízo de devolução',
  motivo:       'Motivo do prejuízo',
  lucro:        'Lucro',
  link:         'Link do anúncio',
};

function parseNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// "01/10/2026 23:57" → timestamp ISO
function parseDateTime(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0).toISOString();
    return null;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, dd, mm, yyRaw, hh = '0', min = '0'] = m;
    const yyyy = yyRaw.length === 2 ? '20' + yyRaw : yyRaw;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min)).toISOString();
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

// ── POST /metrizap/upload ──────────────────────────────────
// Requer `conta` no body: a empresa selecionada no dropdown ANTES do
// upload (não a coluna "Conta" da planilha) — é ela que tag-eia o lote
// importado, para funcionar igual com qualquer marketplace.
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const conta = String(req.body.conta || '').trim();
  if (!conta) return res.status(400).json({ error: 'Selecione a empresa/conta antes de enviar o arquivo' });

  const { rows: contaRows } = await pool.query('SELECT 1 FROM metrizap_contas WHERE conta = $1', [conta]);
  if (!contaRows.length) return res.status(400).json({ error: 'Empresa/conta não cadastrada. Cadastre antes de importar.' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    return res.status(400).json({ error: 'Arquivo inválido: ' + e.message });
  }

  const sheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'vendas') || workbook.SheetNames[workbook.SheetNames.length - 1];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return res.status(400).json({ error: 'Aba "Vendas" não encontrada na planilha' });

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) return res.status(400).json({ error: 'Aba "Vendas" vazia' });

  const headers = rows[0].map(String);
  const dataRows = rows.slice(1);
  const idx = {};
  for (const [field, label] of Object.entries(HEADERS)) {
    idx[field] = headers.findIndex(h => h.trim() === label);
  }
  if (idx.pedido === -1) {
    return res.status(400).json({ error: 'Coluna "Pedido" não encontrada. Verifique se é um export do Metrizap.', headers_detected: headers });
  }
  const get = (row, field) => idx[field] !== -1 ? row[idx[field]] : null;

  const stats = { inserted: 0, updated: 0, skipped: 0, errors: 0, error_details: [] };

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const pedido = String(get(row, 'pedido') || '').trim();
    if (!pedido) { stats.skipped++; continue; }

    const faturamento = parseNum(get(row, 'faturamento'));
    const lucro = parseNum(get(row, 'lucro'));
    const margemPct = faturamento > 0 ? (lucro / faturamento) * 100 : 0;

    try {
      const result = await pool.query(
        `INSERT INTO metrizap_sales
           (pedido, data_venda, marketplace, conta, pacote, item_id, sku, produto, quantidade,
            situacao, status_marketplace, venda_afiliado, comissao_afiliado, logistica, comprador,
            valor_pago_comprador, faturamento, tarifa, frete_vendedor, frete_comprador, imposto,
            custo_produto, prejuizo_devolucao, motivo_prejuizo, lucro, margem_pct, link_anuncio)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (conta, pedido) DO UPDATE SET
           data_venda=EXCLUDED.data_venda, marketplace=EXCLUDED.marketplace, pacote=EXCLUDED.pacote,
           item_id=EXCLUDED.item_id, sku=EXCLUDED.sku, produto=EXCLUDED.produto, quantidade=EXCLUDED.quantidade,
           situacao=EXCLUDED.situacao, status_marketplace=EXCLUDED.status_marketplace,
           venda_afiliado=EXCLUDED.venda_afiliado, comissao_afiliado=EXCLUDED.comissao_afiliado,
           logistica=EXCLUDED.logistica, comprador=EXCLUDED.comprador,
           valor_pago_comprador=EXCLUDED.valor_pago_comprador, faturamento=EXCLUDED.faturamento,
           tarifa=EXCLUDED.tarifa, frete_vendedor=EXCLUDED.frete_vendedor, frete_comprador=EXCLUDED.frete_comprador,
           imposto=EXCLUDED.imposto, custo_produto=EXCLUDED.custo_produto,
           prejuizo_devolucao=EXCLUDED.prejuizo_devolucao, motivo_prejuizo=EXCLUDED.motivo_prejuizo,
           lucro=EXCLUDED.lucro, margem_pct=EXCLUDED.margem_pct, link_anuncio=EXCLUDED.link_anuncio,
           updated_at=now()
         RETURNING (xmax = 0) AS inserted`,
        [
          pedido,
          parseDateTime(get(row, 'data')),
          String(get(row, 'marketplace') || '').trim() || null,
          conta,
          String(get(row, 'pacote') || '').trim() || null,
          String(get(row, 'item_id') || '').trim() || null,
          String(get(row, 'sku') || '').trim() || null,
          String(get(row, 'produto') || '').trim() || null,
          parseInt(get(row, 'quantidade')) || 1,
          String(get(row, 'situacao') || '').trim() || null,
          String(get(row, 'status_mkt') || '').trim() || null,
          String(get(row, 'afiliado') || '').trim().toLowerCase() === 'sim',
          parseNum(get(row, 'comissao')),
          String(get(row, 'logistica') || '').trim() || null,
          String(get(row, 'comprador') || '').trim() || null,
          parseNum(get(row, 'valor_pago')),
          faturamento,
          parseNum(get(row, 'tarifa')),
          parseNum(get(row, 'frete_vend')),
          parseNum(get(row, 'frete_comp')),
          parseNum(get(row, 'imposto')),
          parseNum(get(row, 'custo')),
          parseNum(get(row, 'prejuizo')),
          String(get(row, 'motivo') || '').trim() || null,
          lucro,
          margemPct,
          String(get(row, 'link') || '').trim() || null,
        ]
      );
      if (result.rows[0].inserted) stats.inserted++;
      else stats.updated++;
    } catch (e) {
      stats.errors++;
      if (stats.error_details.length < 10) stats.error_details.push({ row: i + 1, pedido, error: e.message });
    }
  }

  res.json({ ok: true, file: req.file.originalname, sheet: sheetName, total_rows: dataRows.length, conta, ...stats });
  } catch (e) {
    console.error('[metrizap/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /metrizap/contas ───────────────────────────────────
router.get('/contas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM metrizap_contas ORDER BY nome');
    res.json({ contas: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/contas', async (req, res) => {
  const { conta, nome, marketplace } = req.body;
  if (!conta || !nome) return res.status(400).json({ error: 'conta e nome são obrigatórios' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO metrizap_contas (conta, nome, marketplace) VALUES ($1,$2,$3)
       ON CONFLICT (conta) DO UPDATE SET nome=EXCLUDED.nome, marketplace=EXCLUDED.marketplace
       RETURNING *`,
      [String(conta).trim(), String(nome).trim(), marketplace || 'Mercado Livre']
    );
    res.json({ ok: true, conta: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: WHERE clause ───────────────────────────────────
function buildFilters({ date_from, date_to, conta }) {
  const conds = [], params = [];
  const add = (cond, val) => { params.push(val); conds.push(cond.replace('?', `$${params.length}`)); };
  if (date_from) add(`data_venda >= ?::date`, date_from);
  if (date_to)   add(`data_venda < (?::date + interval '1 day')`, date_to);
  if (conta)     add(`conta = ?`, conta);
  return { where: conds.length ? conds.join(' AND ') : '1=1', params };
}

// ── GET /metrizap/resumo ───────────────────────────────────
// Alimenta os 9 cards de pages/vendas.html. Ads não vem da planilha — soma
// manual de metrizap_ads_manual no período/conta filtrados.
router.get('/resumo', async (req, res) => {
  try {
  const { date_from = '', date_to = '', conta = '' } = req.query;
  const f = buildFilters({ date_from, date_to, conta });

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total_vendas,
       COALESCE(SUM(quantidade),0) AS total_qty,
       COALESCE(SUM(faturamento),0) AS faturamento,
       COALESCE(SUM(custo_produto),0) AS custo,
       COALESCE(SUM(imposto),0) AS imposto,
       COALESCE(SUM(tarifa),0) AS tarifa,
       COALESCE(SUM(frete_comprador),0) AS frete_comprador,
       COALESCE(SUM(frete_vendedor),0) AS frete_vendedor,
       COALESCE(SUM(prejuizo_devolucao),0) AS prejuizo_devolucao,
       COALESCE(SUM(lucro),0) AS lucro,
       SUM(CASE WHEN situacao ILIKE '%cancel%' THEN 1 ELSE 0 END) AS qtd_canceladas,
       SUM(CASE WHEN situacao ILIKE '%cancel%' THEN faturamento ELSE 0 END) AS faturamento_cancelado,
       SUM(CASE WHEN situacao NOT ILIKE '%cancel%' THEN 1 ELSE 0 END) AS qtd_aprovadas,
       SUM(CASE WHEN situacao NOT ILIKE '%cancel%' THEN faturamento ELSE 0 END) AS faturamento_aprovado,
       SUM(CASE WHEN situacao NOT ILIKE '%cancel%' THEN lucro ELSE 0 END) AS lucro_aprovado
     FROM metrizap_sales WHERE ${f.where}`,
    f.params
  );
  const s = rows[0] || {};

  const adsF = [];
  const adsParams = [];
  const addAds = (cond, val) => { adsParams.push(val); adsF.push(cond.replace('?', `$${adsParams.length}`)); };
  if (date_from) addAds('data_ref >= ?::date', date_from);
  if (date_to)   addAds('data_ref <= ?::date', date_to);
  if (conta)     addAds('conta = ?', conta);
  const { rows: adsRows } = await pool.query(
    `SELECT COALESCE(SUM(valor),0) AS total_ads FROM metrizap_ads_manual WHERE ${adsF.length ? adsF.join(' AND ') : '1=1'}`,
    adsParams
  );
  const totalAds = Number(adsRows[0]?.total_ads || 0);

  const custos = Number(s.custo||0) + Number(s.imposto||0) + Number(s.tarifa||0) + Number(s.frete_vendedor||0) + totalAds;
  const lucroLiquido = Number(s.lucro_aprovado||0) - totalAds;

  res.json({
    faturamento_aprovado: Number(s.faturamento_aprovado||0),
    faturamento_cancelado: Number(s.faturamento_cancelado||0),
    custo: Number(s.custo||0),
    imposto: Number(s.imposto||0),
    tarifa: Number(s.tarifa||0),
    frete_comprador: Number(s.frete_comprador||0),
    frete_vendedor: Number(s.frete_vendedor||0),
    prejuizo_devolucao: Number(s.prejuizo_devolucao||0),
    lucro_aprovado: Number(s.lucro_aprovado||0),
    margem_pct: Number(s.faturamento_aprovado) > 0 ? (Number(s.lucro_aprovado)/Number(s.faturamento_aprovado)*100) : 0,
    qtd_aprovadas: Number(s.qtd_aprovadas||0),
    qtd_canceladas: Number(s.qtd_canceladas||0),
    ticket_medio: Number(s.qtd_aprovadas) > 0 ? Number(s.faturamento_aprovado)/Number(s.qtd_aprovadas) : 0,
    mc_medio: Number(s.qtd_aprovadas) > 0 ? Number(s.lucro_aprovado)/Number(s.qtd_aprovadas) : 0,
    ads: totalAds,
    roi: custos > 0 ? (lucroLiquido/custos*100) : 0,
  });
  } catch (e) {
    console.error('[metrizap/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET/POST /metrizap/ads ─────────────────────────────────
router.get('/ads', async (req, res) => {
  try {
    const { conta = '', date_from = '', date_to = '' } = req.query;
    const f = buildFiltersAds({ conta, date_from, date_to });
    const { rows } = await pool.query(`SELECT * FROM metrizap_ads_manual WHERE ${f.where} ORDER BY data_ref DESC`, f.params);
    res.json({ ads: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
function buildFiltersAds({ conta, date_from, date_to }) {
  const conds = [], params = [];
  const add = (cond, val) => { params.push(val); conds.push(cond.replace('?', `$${params.length}`)); };
  if (conta) add('conta = ?', conta);
  if (date_from) add('data_ref >= ?::date', date_from);
  if (date_to) add('data_ref <= ?::date', date_to);
  return { where: conds.length ? conds.join(' AND ') : '1=1', params };
}

router.post('/ads', async (req, res) => {
  const { conta, data_ref, valor } = req.body;
  if (!conta || !data_ref) return res.status(400).json({ error: 'conta e data_ref são obrigatórios' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO metrizap_ads_manual (conta, data_ref, valor) VALUES ($1,$2,$3)
       ON CONFLICT (conta, data_ref) DO UPDATE SET valor=EXCLUDED.valor, updated_at=now()
       RETURNING *`,
      [String(conta).trim(), data_ref, parseNum(valor)]
    );
    res.json({ ok: true, ads: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /metrizap/vendas ────────────────────────────────────
// Listagem detalhada, uma linha por venda — alimenta pages/vendas-detalhadas.html.
router.get('/vendas', async (req, res) => {
  try {
    const { date_from='', date_to='', conta='', sku='', situacao='', search='', page=1, limit=200 } = req.query;
    const conds = [], params = [];
    const add = (cond, val) => { params.push(val); conds.push(cond.replace('?', `$${params.length}`)); };
    if (date_from) add(`ms.data_venda >= ?::date`, date_from);
    if (date_to)   add(`ms.data_venda < (?::date + interval '1 day')`, date_to);
    if (conta)     add(`ms.conta = ?`, conta);
    if (sku)       add(`ms.sku ILIKE ?`, `%${sku}%`);
    if (situacao)  add(`ms.situacao ILIKE ?`, `%${situacao}%`);
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      conds.push(`(ms.produto ILIKE $${params.length - 1} OR ms.pedido ILIKE $${params.length})`);
    }
    const where = conds.length ? conds.join(' AND ') : '1=1';
    const offset = (Number(page) - 1) * Number(limit);

    const [data, count] = await Promise.all([
      pool.query(
        `SELECT ms.*, mc.nome AS conta_nome FROM metrizap_sales ms
         LEFT JOIN metrizap_contas mc ON mc.conta = ms.conta
         WHERE ${where}
         ORDER BY ms.data_venda DESC NULLS LAST, ms.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Number(limit), offset]
      ),
      pool.query(`SELECT COUNT(*) FROM metrizap_sales ms WHERE ${where}`, params),
    ]);

    res.json({ vendas: data.rows, total: Number(count.rows[0].count), page: Number(page), limit: Number(limit) });
  } catch (e) {
    console.error('[metrizap/vendas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
