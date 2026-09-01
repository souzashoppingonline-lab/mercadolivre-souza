// Rotas do módulo FINANCEIRO — leem do Supabase separado (read-only), nunca do
// Postgres principal. Montadas em /api/financeiro (só admin — ver MODULES em
// routes/staffAuth.js). Ver .claude/modules.md.
const express = require('express');
const supa = require('../db/supabaseFin');
const calc = require('../financeiroCalc');
const { sendClosingEmail } = require('../fechamentoMensalEmail');

const router = express.Router();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Status do módulo — a página usa pra saber se está configurado e conectado.
router.get('/status', async (req, res) => {
  try {
    res.json(await supa.ping());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista as tabelas do Supabase financeiro.
router.get('/tabelas', async (req, res) => {
  try {
    res.json({ tabelas: await supa.listTables() });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Prévia de linhas de uma tabela (read-only, no máx. 200).
router.get('/tabela/:nome', async (req, res) => {
  try {
    const rows = await supa.previewTable(req.params.nome, req.query.limit);
    res.json({ tabela: req.params.nome, total: Array.isArray(rows) ? rows.length : 0, rows });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Dados de uma tabela p/ as telas reais (read-only, limite maior, order opcional).
router.get('/dados/:nome', async (req, res) => {
  try {
    const rows = await supa.selectRows(req.params.nome, req.query.limit, req.query.order, req.query.filtro);
    res.json({ tabela: req.params.nome, total: Array.isArray(rows) ? rows.length : 0, rows });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Escrita (migração) — só tabelas da allowlist em supabaseFin (WRITE_ALLOW).
// Exige a chave service_role (sb_secret) no servidor; com a publishable falha.
function handleWriteErr(res, e) {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
  return res.status(e.status || 500).json({ error: e.message });
}
router.post('/dados/:nome', async (req, res) => {
  try { res.json({ rows: await supa.insertRow(req.params.nome, req.body) }); }
  catch (e) { handleWriteErr(res, e); }
});
router.patch('/dados/:nome/:id', async (req, res) => {
  try { res.json({ rows: await supa.updateRow(req.params.nome, req.params.id, req.body) }); }
  catch (e) { handleWriteErr(res, e); }
});
router.delete('/dados/:nome/:id', async (req, res) => {
  try { res.json({ rows: await supa.deleteRow(req.params.nome, req.params.id) }); }
  catch (e) { handleWriteErr(res, e); }
});

// ── Comprovante fiscal (arquivo) ────────────────────────────────────────────
// Upload em memória: o arquivo só passa por aqui a caminho do Storage do
// Supabase, não fica no disco do servidor (ao contrário do vídeo de embalagem,
// que é grande e mora local). 20 MB cobre PDF de nota e foto de comprovante.
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const EXT_OK = /\.(xml|pdf|png|jpe?g|webp)$/i;
const seguro = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80);

router.post('/arquivo', (req, res) => {
  upload.single('arquivo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 20 MB.' : err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'nenhum arquivo enviado' });
      if (!EXT_OK.test(req.file.originalname)) {
        return res.status(400).json({ error: 'formato não aceito — envie XML, PDF, PNG, JPG ou WEBP' });
      }
      // Caminho previsível e sem colisão: empresa/ano-mes/timestamp-nome.
      const empresa = seguro(req.body.empresa || 'sem-empresa');
      const comp = /^\d{4}-\d{2}$/.test(req.body.competencia || '') ? req.body.competencia : new Date().toISOString().slice(0, 7);
      const caminho = `${empresa}/${comp}/${Date.now()}-${seguro(req.file.originalname)}`;
      const gravado = await supa.uploadObject(caminho, req.file.buffer, req.file.mimetype);
      res.json({ path: gravado, nome: req.file.originalname, tamanho: req.file.size });
    } catch (e) { handleWriteErr(res, e); }
  });
});

// Download do comprovante. O bucket é privado — quem serve é o servidor, com a
// chave dele, atrás do gate de admin do módulo (ver MODULES em staffAuth).
router.get('/arquivo/:caminho(*)', async (req, res) => {
  try {
    const caminho = String(req.params.caminho || '');
    if (!caminho || caminho.includes('..')) return res.status(400).json({ error: 'caminho inválido' });
    const { buffer, contentType } = await supa.downloadObject(caminho);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${caminho.split('/').pop()}"`);
    res.send(buffer);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Fechamento Mensal (monthly_closing) — checklist, status, e-mail ────────
// Cálculo 100% em server/src/financeiroCalc.js (getFechamentoMensal) — a
// mesma fórmula de DRE de getDRE(), nunca uma cópia nova aqui. Ver
// .claude/modules.md e .claude/decisions.md.
const CHECKLIST_ITENS = [
  { key: 'vendas', label: 'Vendas lançadas', obrigatorio: true },
  { key: 'despesas', label: 'Despesas lançadas', obrigatorio: true },
  { key: 'fluxo_caixa', label: 'Fluxo de caixa conferido', obrigatorio: true },
  { key: 'boletos', label: 'Boletos conferidos', obrigatorio: true },
  { key: 'sku', label: 'SKU/produtos conferidos', obrigatorio: true },
  { key: 'dre', label: 'DRE revisado', obrigatorio: true },
  { key: 'ads', label: 'Custos de Ads conferidos', obrigatorio: true },
  { key: 'estoque_cmv', label: 'Estoque/CMV conferido', obrigatorio: false },
];

// Último dia ÚTIL do mês (pula sáb/dom; não há calendário de feriados
// brasileiros aqui — simplificação documentada em decisions.md).
function ultimoDiaUtil(mes, ano) {
  const d = new Date(ano, mes, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}
// "Só finaliza no último dia útil" travaria pra sempre um mês em atraso (uma
// vez que o mês já passou, "hoje === aquele dia" nunca mais é verdade) —
// reinterpretado como "só finaliza a PARTIR do último dia útil" (hoje >=
// limite), preservando a intenção (não fechar cedo demais, com dado ainda
// incompleto) sem impedir fechar um mês atrasado depois. Ver decisions.md.
function podeFinalizar(mes, ano) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const limite = ultimoDiaUtil(mes, ano); limite.setHours(0, 0, 0, 0);
  return hoje >= limite;
}
function findClosing(rows, mes, ano) { return rows.find((c) => Number(c.month) === mes && Number(c.year) === ano) || null; }
function lucroLiquidoDoFechamento(c) {
  return round2((+c.contribution_margin || 0) - (+c.fixed_costs_total || 0) - (+c.variable_costs_total || 0));
}
const numOrNull = (v) => (v == null ? null : Number(v));

// Reconstrói o "report" de exibição a partir das COLUNAS PRÓPRIAS de
// monthly_closing (nunca de report_data) — são a fonte confiável mesmo pra
// fechamentos que existiam ANTES desta página (o sistema/wizard externo já
// fechava mês e gravava essas colunas; é o que financeiro-projecao-caixa.html
// já lia). `report_data` (se veio no formato desta página — tem
// `revenue_gross` dentro) só é usado como fonte MELHOR quando disponível,
// nunca a única fonte — evitar o bug de mostrar tudo "—"/"undefined" quando
// um mês foi fechado por outro caminho e report_data ficou vazio/formato
// diferente (ver decisions.md).
async function buildReportFromClosing(c) {
  const rd = (c.report_data && c.report_data.revenue_gross != null) ? c.report_data : {};
  const temCustos = c.fixed_costs_total != null || c.variable_costs_total != null;
  const netPctCol = (c.dre_data && c.dre_data.net_pct != null) ? +c.dre_data.net_pct : null;
  const revenue = numOrNull(c.revenue_gross);
  const llReais = rd.lucro_liquido != null ? rd.lucro_liquido
    : (temCustos ? lucroLiquidoDoFechamento(c) : (revenue && netPctCol != null ? round2(revenue * netPctCol / 100) : null));
  const llPct = rd.net_pct != null ? rd.net_pct : (netPctCol != null ? netPctCol : (revenue ? round2((llReais / revenue) * 100) : null));

  // Impostos/Taxas Marketplace/Frete Subsidiado: monthly_closing NÃO tem
  // coluna própria pra esses 3 itens (só agregados: cogs_total/ads_*) — só
  // existem se report_data (no formato desta página) os guardou. Fechamento
  // sem esse detalhe (feito fora desta página) tinha esses 3 campos sempre
  // "—", mesmo com CMV/Ads/Margem corretos — buscados ao vivo em
  // sales_entries só pra esse detalhe (getSalesBreakdown), sem tocar nos
  // totais já travados (revenue_gross/contribution_margin/lucro seguem das
  // colunas). Ver decisions.md.
  let marketplace_fees = rd.marketplace_fees ?? null, subsidized_shipping = rd.subsidized_shipping ?? null, tax = rd.tax ?? null;
  if (marketplace_fees == null && subsidized_shipping == null && tax == null && revenue) {
    try {
      const det = await calc.getSalesBreakdown({ mes: c.month, ano: c.year });
      marketplace_fees = det.marketplace_fees; subsidized_shipping = det.subsidized_shipping; tax = det.tax;
    } catch (e) { console.warn(`[fechamento-mensal] getSalesBreakdown falhou pra ${c.month}/${c.year}:`, e.message); }
  }

  return {
    mes: Number(c.month), ano: Number(c.year),
    revenue_gross: revenue, revenue_total: numOrNull(c.revenue_total) ?? revenue,
    marketplace_fees, subsidized_shipping, tax,
    cogs_total: numOrNull(c.cogs_total), ads_ml: numOrNull(c.ads_ml), ads_external: numOrNull(c.ads_external),
    ads_cost_total: numOrNull(c.ads_cost_total),
    contribution_margin: numOrNull(c.contribution_margin), contribution_margin_pct: numOrNull(c.contribution_margin_pct),
    fixed_costs_total: numOrNull(c.fixed_costs_total), variable_costs_total: numOrNull(c.variable_costs_total),
    lucro_liquido: llReais, net_pct: llPct,
    total_sales: c.total_sales ?? null, avg_ticket: numOrNull(c.avg_ticket),
    cash_flow_in: numOrNull(c.cash_flow_in), cash_flow_out: numOrNull(c.cash_flow_out), cash_flow_balance: numOrNull(c.cash_flow_balance),
    boletos_paid_count: c.boletos_paid_count ?? 0, boletos_paid_total: numOrNull(c.boletos_paid_total) ?? 0,
    boletos_pending_count: c.boletos_pending_count ?? 0, boletos_pending_total: numOrNull(c.boletos_pending_total) ?? 0,
    boletos_itens: rd.boletos_itens || [],
    expense_categories_top: rd.expense_categories_top || (Array.isArray(c.expense_categories) ? c.expense_categories : []),
    meta: rd.meta || null,
    comparativo_mes_anterior: rd.comparativo_mes_anterior || null,
    // Fechamento que não veio desta página (sem report_data no nosso
    // formato) — checklist/boletos_itens/categorias/meta detalhados não
    // existem pra ele, só os totais das colunas. Frontend usa isso pra
    // avisar em vez de fingir "nenhum item marcado".
    historico_sem_checklist: !(c.report_data && c.report_data.checklist),
  };
}

// Grade de 12 meses (status) + 5 summary cards (só meses fechados do ano).
router.get('/fechamento/resumo', async (req, res) => {
  try {
    const ano = Number(req.query.ano) || new Date().getFullYear();
    const hoje = new Date();
    const closings = await supa.selectRows('monthly_closing', 500);
    const meses = [];
    for (let m = 1; m <= 12; m++) {
      const c = findClosing(closings, m, ano);
      const futuro = ano === hoje.getFullYear() && m > hoje.getMonth() + 1;
      const atual = ano === hoje.getFullYear() && m === hoje.getMonth() + 1;
      meses.push({
        mes: m, atual,
        status: c ? c.status : (futuro ? 'futuro' : 'open'),
        revenue_gross: c ? round2(c.revenue_gross) : null,
        lucro_liquido: c ? lucroLiquidoDoFechamento(c) : null,
      });
    }
    const fechados = closings.filter((c) => Number(c.year) === ano && c.status === 'closed');
    const soma = (f) => fechados.reduce((s, c) => s + (f(c) || 0), 0);
    const receitaFechada = soma((c) => +c.revenue_gross || 0);
    const mcFechada = soma((c) => +c.contribution_margin || 0);
    const llFechado = soma(lucroLiquidoDoFechamento);
    res.json({
      ano, meses,
      summary: {
        ano_fiscal: ano,
        receita_fechada: round2(receitaFechada),
        margem_contribuicao: round2(mcFechada),
        margem_contribuicao_pct: receitaFechada ? round2((mcFechada / receitaFechada) * 100) : 0,
        lucro_liquido: round2(llFechado),
        lucro_liquido_pct: receitaFechada ? round2((llFechado / receitaFechada) * 100) : 0,
        vendas: soma((c) => +c.total_sales || 0),
        meses_fechados: fechados.length,
      },
      checklist_itens: CHECKLIST_ITENS,
    });
  } catch (e) { handleWriteErr(res, e); }
});

// Detalhe de um mês: fechado → devolve o snapshot gravado (nunca recalcula
// um mês já travado). open/in_progress → calcula AO VIVO (mesma fórmula que
// será gravada ao finalizar), pra refletir lançamentos feitos até agora.
router.get('/fechamento/:ano/:mes', async (req, res) => {
  try {
    const ano = Number(req.params.ano), mes = Number(req.params.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'ano/mês inválidos' });
    const closings = await supa.selectRows('monthly_closing', 500);
    const existente = findClosing(closings, mes, ano);
    const report = (existente && existente.status === 'closed')
      ? await buildReportFromClosing(existente)
      : await calc.getFechamentoMensal({ mes, ano });
    res.json({
      report,
      status: existente ? existente.status : 'open',
      checklist: (existente && existente.report_data && existente.report_data.checklist) || {},
      notes: (existente && existente.notes) || '',
      pode_finalizar: podeFinalizar(mes, ano),
      checklist_itens: CHECKLIST_ITENS,
      closed_at: (existente && existente.closed_at) || null,
    });
  } catch (e) { handleWriteErr(res, e); }
});

router.post('/fechamento/:ano/:mes/iniciar', async (req, res) => {
  try {
    const ano = Number(req.params.ano), mes = Number(req.params.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'ano/mês inválidos' });
    const closings = await supa.selectRows('monthly_closing', 500);
    const existente = findClosing(closings, mes, ano);
    if (existente && existente.status === 'closed') return res.status(400).json({ error: 'Mês já fechado — reabra antes de iniciar de novo.' });
    const rows = await supa.upsertRow('monthly_closing', { month: mes, year: ano, status: 'in_progress' }, 'month,year');
    res.json({ ok: true, closing: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) { handleWriteErr(res, e); }
});

router.patch('/fechamento/:ano/:mes/checklist', async (req, res) => {
  try {
    const ano = Number(req.params.ano), mes = Number(req.params.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'ano/mês inválidos' });
    const closings = await supa.selectRows('monthly_closing', 500);
    const existente = findClosing(closings, mes, ano);
    if (!existente || existente.status === 'closed') return res.status(400).json({ error: 'Inicie o fechamento antes de marcar o checklist.' });
    const chaves = new Set(CHECKLIST_ITENS.map((i) => i.key));
    const checklistAtual = { ...((existente.report_data && existente.report_data.checklist) || {}) };
    if (req.body.item !== undefined) {
      if (!chaves.has(req.body.item)) return res.status(400).json({ error: 'item de checklist inválido' });
      checklistAtual[req.body.item] = !!req.body.checked;
    }
    const patch = { report_data: { ...(existente.report_data || {}), checklist: checklistAtual } };
    if (req.body.notes !== undefined) patch.notes = String(req.body.notes || '').slice(0, 500);
    await supa.updateRow('monthly_closing', existente.id, patch);
    res.json({ ok: true, checklist: checklistAtual });
  } catch (e) { handleWriteErr(res, e); }
});

router.post('/fechamento/:ano/:mes/finalizar', async (req, res) => {
  try {
    const ano = Number(req.params.ano), mes = Number(req.params.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'ano/mês inválidos' });
    const closings = await supa.selectRows('monthly_closing', 500);
    const existente = findClosing(closings, mes, ano);
    if (!existente || existente.status !== 'in_progress') return res.status(400).json({ error: 'Inicie o fechamento (checklist completo) antes de finalizar.' });
    const checklist = (existente.report_data && existente.report_data.checklist) || {};
    const faltando = CHECKLIST_ITENS.filter((i) => i.obrigatorio && !checklist[i.key]);
    if (faltando.length) return res.status(400).json({ error: `Checklist incompleto: ${faltando.map((i) => i.label).join(', ')}` });
    if (!podeFinalizar(mes, ano)) return res.status(400).json({ error: 'Só é possível finalizar a partir do último dia útil do mês.' });

    const report = await calc.getFechamentoMensal({ mes, ano });
    const patch = {
      status: 'closed', closed_at: new Date().toISOString(),
      revenue_gross: report.revenue_gross, revenue_total: report.revenue_total,
      cogs_total: report.cogs_total, fixed_costs_total: report.fixed_costs_total, variable_costs_total: report.variable_costs_total,
      contribution_margin: report.contribution_margin, contribution_margin_pct: report.contribution_margin_pct,
      ads_cost_total: report.ads_cost_total, ads_ml: report.ads_ml, ads_external: report.ads_external,
      total_sales: report.total_sales, avg_ticket: report.avg_ticket,
      cash_flow_in: report.cash_flow_in, cash_flow_out: report.cash_flow_out, cash_flow_balance: report.cash_flow_balance,
      boletos_paid_count: report.boletos_paid_count, boletos_paid_total: report.boletos_paid_total,
      boletos_pending_count: report.boletos_pending_count, boletos_pending_total: report.boletos_pending_total,
      expense_categories: report.expense_categories_top,
      // dre_data.net_pct é o campo que financeiro-projecao-caixa.html lê como
      // "Lucro Líq. % de verdade" (ver decisions.md — bug corrigido nesta
      // mesma sessão) — gravar aqui é o que faz aquela tela mostrar o número
      // certo pros meses fechados por ESTA página.
      dre_data: { net_pct: report.net_pct, lucro_liquido: report.lucro_liquido },
      report_data: { ...report, checklist },
      notes: existente.notes || null,
    };
    const rows = await supa.updateRow('monthly_closing', existente.id, patch);
    // Não deixa a finalização falhar por causa do e-mail — o fechamento em
    // si já está gravado no ponto acima (mesmo racional de sendReportEmail
    // no worker: erro de e-mail só loga, nunca desfaz o que já foi salvo).
    let email = { sent: false };
    try { email = await sendClosingEmail({ ...report, notes: existente.notes || '' }); }
    catch (e) { console.error('[fechamento-mensal] falha ao enviar e-mail:', e.message); email = { sent: false, reason: e.message }; }
    res.json({ ok: true, closing: Array.isArray(rows) ? rows[0] : rows, email });
  } catch (e) { handleWriteErr(res, e); }
});

// "Reabrir" — sem checagem extra de papel aqui: TODO o módulo Financeiro já
// é admin-only (ver comentário no topo deste arquivo / staffAuth MODULES).
router.post('/fechamento/:ano/:mes/reabrir', async (req, res) => {
  try {
    const ano = Number(req.params.ano), mes = Number(req.params.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'ano/mês inválidos' });
    const closings = await supa.selectRows('monthly_closing', 500);
    const existente = findClosing(closings, mes, ano);
    if (!existente) return res.status(404).json({ error: 'Mês não encontrado' });
    const rows = await supa.updateRow('monthly_closing', existente.id, { status: 'open', closed_at: null });
    res.json({ ok: true, closing: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) { handleWriteErr(res, e); }
});

module.exports = router;
