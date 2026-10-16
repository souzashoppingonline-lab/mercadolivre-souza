// Inteligência de Vendas — módulo Inteligência de Negócio (BI), Fase 1.
// Lê sales_entries_detail (uma linha por venda, qualquer marketplace — ver
// finance.md) + sales_entries (Ads manual já existente em Vendas & Custos)
// do Supabase do Financeiro, agregando por produto. Mesmo dado que
// pages/financeiro-vendas-detalhadas.html mostra cru, aqui agrupado —
// nunca recalcula lucro/margem (usa o valor já gravado por venda, ver
// finance.md pra fórmula). Montado em /api/bi/vendas — dentro do gate
// MODULES.bi (admin), o prefixo /api/bi já cobre qualquer rota abaixo dele
// (ver staffAuth.js). Ver .claude/modules.md.
const express = require('express');
const supa = require('../db/supabaseFin');
const pareto = require('../pareto');
const importacao = require('../importacaoMetrizap');

const router = express.Router();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function noPeriodo(dateStr, date_from, date_to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (date_from && d < date_from) return false;
  if (date_to && d > date_to) return false;
  return true;
}

// Busca só o período pedido, filtrando por data/loja NO Supabase e paginando
// de 1000 em 1000 (teto padrão de linhas por resposta do PostgREST do
// Supabase). Antes lia "as 5000 mais recentes" e filtrava em JS: passando de
// 1000 vendas na tabela, períodos antigos sumiam da análise sem aviso.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAGINA = 1000;
const MAX_PAGINAS = 50;
async function loadPeriodo(tabela, date_from, date_to, store_id) {
  let base = `/${tabela}?order=date.desc,id.desc`;
  if (ISO_DATE.test(date_from || '')) base += `&date=gte.${date_from}`;
  if (ISO_DATE.test(date_to || '')) base += `&date=lte.${date_to}`;
  if (store_id) base += `&store_id=eq.${encodeURIComponent(store_id)}`;
  const out = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const page = await supa.get(`${base}&limit=${PAGINA}&offset=${p * PAGINA}`);
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < PAGINA) break;
  }
  return out.filter(r =>
    noPeriodo(r.date, date_from, date_to) &&
    (!store_id || String(r.store_id) === String(store_id))
  );
}

// Venda cancelada fica de fora de TODA análise — mesma regra do import
// Metrizap (financeiro-vendas.html, `/cancel/i` em "Situação"), que já não
// soma canceladas no agregado diário de sales_entries. Sem isso, cancelada
// entrava como venda (faturamento + qtd, lucro 0) e inflava ranking,
// Prospecção ("precisa comprar") e derrubava a margem. Devolução parcial
// continua contando — é venda real, com lucro próprio.
async function loadDetalhe(date_from, date_to, store_id) {
  const rows = await loadPeriodo('sales_entries_detail', date_from, date_to, store_id);
  return rows.filter(r => !/cancel/i.test(String(r.situacao || '')));
}

// Ads é o único número que não vem de sales_entries_detail: a planilha
// Metrizap não tem coluna de Ads — o valor é digitado no modal do próprio
// import Metrizap e gravado por dia+loja em sales_entries.ads_ml.
async function loadAds(date_from, date_to, store_id) {
  return loadPeriodo('sales_entries', date_from, date_to, store_id);
}

function agruparPorProduto(rows) {
  const by = {};
  rows.forEach(r => {
    const key = `${r.store_id}::${r.sku || r.produto || '—'}`;
    const g = by[key] || (by[key] = {
      store_id: r.store_id, sku: r.sku || null, produto: null,
      quantidade: 0, faturamento: 0, lucro: 0, vendas: 0, comissao_afiliado: 0,
    });
    if (!g.produto && r.produto) g.produto = r.produto;
    g.quantidade += Number(r.quantidade) || 0;
    g.faturamento += Number(r.faturamento) || 0;
    g.lucro += Number(r.lucro) || 0;
    g.comissao_afiliado += Number(r.comissao_afiliado) || 0;
    g.vendas += 1;
  });
  return Object.values(by).map(g => ({
    ...g,
    produto: g.produto || '(sem título)',
    faturamento: round2(g.faturamento),
    lucro: round2(g.lucro),
    comissao_afiliado: round2(g.comissao_afiliado),
    // já é custo que SAIU do lucro gravado por venda (ver finance.md) — aqui só
    // expõe o valor/% pra enxergar o quanto o afiliado está custando por produto.
    pct_afiliado: g.faturamento > 0 ? round2(g.comissao_afiliado / g.faturamento * 100) : 0,
    margem_pct: g.faturamento > 0 ? round2(g.lucro / g.faturamento * 100) : 0,
  }));
}

const CAMPO_ORDENACAO = { qtd: 'quantidade', faturamento: 'faturamento', lucro: 'lucro', margem: 'margem_pct', afiliado: 'comissao_afiliado' };

// GET /api/bi/vendas/produtos?date_from&date_to&store_id&ordenar=qtd|faturamento|lucro|margem&dir=asc|desc&limit
// Serve as 3 abas da Fase 1: "Mais Vendidos" (ordenar=qtd&dir=desc, default),
// "Baixo Giro" (ordenar=qtd&dir=asc) e "Margem por Produto" (ordenar=margem&dir=desc)
// — mesmo agrupamento, só muda ordenação/direção, sem duplicar a query.
router.get('/produtos', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '', ordenar = 'qtd', dir = 'desc', limit = 50 } = req.query;
    const rows = await loadDetalhe(date_from, date_to, store_id);
    let produtos = agruparPorProduto(rows);
    const campo = CAMPO_ORDENACAO[ordenar] || 'quantidade';
    produtos.sort((a, b) => dir === 'asc' ? a[campo] - b[campo] : b[campo] - a[campo]);
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    res.json({ produtos: produtos.slice(0, lim), total_produtos: produtos.length, total_linhas: rows.length });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/bi/vendas/resumo?date_from&date_to&store_id — KPIs do período +
// Ads manual (campo já existente em sales_entries, ver finance.md). NÃO
// rateia Ads por produto — a granularidade de sales_entries é por dia+loja,
// dividir isso por SKU seria um número inventado, não um dado real.
router.get('/resumo', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '' } = req.query;
    const [detalhe, entries] = await Promise.all([
      loadDetalhe(date_from, date_to, store_id),
      loadAds(date_from, date_to, store_id),
    ]);
    const s = { faturamento: 0, custo: 0, imposto: 0, tarifa: 0, frete_vendedor: 0, lucro: 0 };
    detalhe.forEach(r => {
      s.faturamento += Number(r.faturamento) || 0;
      s.custo += Number(r.custo_produto) || 0;
      s.imposto += Number(r.imposto) || 0;
      s.tarifa += Number(r.tarifa) || 0;
      s.frete_vendedor += Number(r.frete_vendedor) || 0;
      s.lucro += Number(r.lucro) || 0;
    });
    const ads = entries.reduce((sum, e) => sum + (Number(e.ads_ml) || 0) + (Number(e.ads_external) || 0), 0);

    // ROI é só Mercado Livre — pedido explícito do usuário: os outros
    // marketplaces (TikTok Shop, Shopee) não usam Ads hoje, então misturar o
    // lucro/custo deles no mesmo ROI que leva Ads em conta distorce o número
    // (lucro "de graça" sem Ads inflando o ROI de uma conta que só é cara
    // por causa do ML). Usa só `ads_ml` no numerador/denominador também, não
    // `ads_external`. Ver decisions.md.
    const detalheML = detalhe.filter(r => r.marketplace === 'Mercado Livre');
    const sML = { custo: 0, imposto: 0, tarifa: 0, frete_vendedor: 0, lucro: 0 };
    detalheML.forEach(r => {
      sML.custo += Number(r.custo_produto) || 0;
      sML.imposto += Number(r.imposto) || 0;
      sML.tarifa += Number(r.tarifa) || 0;
      sML.frete_vendedor += Number(r.frete_vendedor) || 0;
      sML.lucro += Number(r.lucro) || 0;
    });
    const adsMl = entries.reduce((sum, e) => sum + (Number(e.ads_ml) || 0), 0);
    const custosTotaisML = sML.custo + sML.imposto + sML.tarifa + sML.frete_vendedor + adsMl;

    const skusDistintos = new Set(detalhe.map(r => `${r.store_id}::${r.sku || r.produto}`)).size;
    // Lucro = mesmo critério do painel do Metrizap ("Ads descontado do
    // lucro"): soma do lucro por venda MENOS o Ads do período. O lucro por
    // venda da planilha não tem Ads (não existe coluna por venda), então sem
    // isso o KPI ficava maior que o do Metrizap. Ver business-rules.md.
    const lucroAposAds = s.lucro - ads;
    res.json({
      total_vendas: detalhe.length,
      skus_distintos: skusDistintos,
      faturamento: round2(s.faturamento),
      lucro: round2(lucroAposAds),
      lucro_antes_ads: round2(s.lucro),
      margem_pct: s.faturamento > 0 ? round2(lucroAposAds / s.faturamento * 100) : 0,
      ultima_data: detalhe.reduce((m, r) => (r.date && String(r.date).slice(0, 10) > m ? String(r.date).slice(0, 10) : m), '') || null,
      ads: round2(ads),
      roi: custosTotaisML > 0 ? round2((sML.lucro - adsMl) / custosTotaisML * 100) : 0,
    });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Período imediatamente anterior, mesma duração — mesmo critério já usado em
// GET /api/bi/painel (Painel Estratégico, cresc_receita/cresc_pedidos).
function periodoAnterior(date_from, date_to) {
  if (!date_from || !date_to) return { de: '', ate: '' };
  const d1 = new Date(date_from + 'T00:00:00');
  const d2 = new Date(date_to + 'T00:00:00');
  const dias = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
  const ateAnt = new Date(d1.getTime() - 86400000);
  const deAnt = new Date(ateAnt.getTime() - (dias - 1) * 86400000);
  const iso = d => d.toISOString().slice(0, 10);
  return { de: iso(deAnt), ate: iso(ateAnt) };
}

// GET /api/bi/vendas/lojas?date_from&date_to — aba "Vendas por Loja":
// faturamento/margem/qtd por loja no período, Ads por loja (mesmo campo
// manual do /resumo, aqui desagregado por loja em vez de somado), e
// crescimento % vs. o período anterior de mesma duração (mesmo critério do
// Painel Estratégico). `diaria` alimenta o gráfico de aumento/queda.
router.get('/lojas', async (req, res) => {
  try {
    const { date_from = '', date_to = '' } = req.query;
    const anterior = periodoAnterior(date_from, date_to);
    const [atual, passado, ads] = await Promise.all([
      loadDetalhe(date_from, date_to),
      anterior.de ? loadDetalhe(anterior.de, anterior.ate) : Promise.resolve([]),
      loadAds(date_from, date_to),
    ]);

    const porLoja = {};
    const getG = (id) => porLoja[id] || (porLoja[id] = { store_id: id, faturamento: 0, lucro: 0, quantidade: 0, vendas: 0, faturamento_anterior: 0, ads: 0, ultima_data: '' });
    atual.forEach(r => {
      const g = getG(r.store_id);
      g.faturamento += Number(r.faturamento) || 0;
      g.lucro += Number(r.lucro) || 0;
      g.quantidade += Number(r.quantidade) || 0;
      g.vendas += 1;
      const d = r.date ? String(r.date).slice(0, 10) : '';
      if (d > g.ultima_data) g.ultima_data = d;
    });
    passado.forEach(r => { getG(r.store_id).faturamento_anterior += Number(r.faturamento) || 0; });
    ads.forEach(e => { getG(e.store_id).ads += (Number(e.ads_ml) || 0) + (Number(e.ads_external) || 0); });

    // Lucro/margem da loja já com o Ads da loja descontado — mesmo critério
    // do /resumo e do painel do Metrizap.
    const lojas = Object.values(porLoja).map(g => ({
      store_id: g.store_id,
      faturamento: round2(g.faturamento),
      lucro: round2(g.lucro - g.ads),
      lucro_antes_ads: round2(g.lucro),
      quantidade: g.quantidade,
      vendas: g.vendas,
      ultima_data: g.ultima_data || null,
      faturamento_anterior: round2(g.faturamento_anterior),
      ads: round2(g.ads),
      margem_pct: g.faturamento > 0 ? round2((g.lucro - g.ads) / g.faturamento * 100) : 0,
      // null (não 0) quando não há período anterior pra comparar — frontend
      // mostra "sem comparativo" em vez de uma queda de 100% inventada.
      cresc_pct: g.faturamento_anterior > 0 ? round2((g.faturamento - g.faturamento_anterior) / g.faturamento_anterior * 100) : null,
    })).sort((a, b) => b.faturamento - a.faturamento);

    const diariaMap = {};
    atual.forEach(r => {
      if (!r.date) return;
      const key = `${String(r.date).slice(0, 10)}::${r.store_id}`;
      diariaMap[key] = (diariaMap[key] || 0) + (Number(r.faturamento) || 0);
    });
    const diaria = Object.entries(diariaMap)
      .map(([key, faturamento]) => { const [date, store_id] = key.split('::'); return { date, store_id, faturamento: round2(faturamento) }; })
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ lojas, diaria, periodo_anterior: anterior });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// "Mesmo dia do mês passado" — mesmo número de dia, um mês antes, com
// clamp pro último dia válido (ex.: 31/mar → 28 ou 29/fev). "Dia anterior"
// é trivial (dia − 1).
function mesmoDiaMesPassado(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const alvo = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d.getDate(), ultimoDia));
  return alvo.toISOString().slice(0, 10);
}
function diaAnterior(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function crescPct(atual, anterior) {
  return anterior > 0 ? round2((atual - anterior) / anterior * 100) : null;
}

// GET /api/bi/vendas/lojas/:storeId/dias?date_from&date_to — modal de
// detalhamento dia a dia de UMA loja (clique na linha da tabela "Vendas por
// Loja"): faturamento/Ads/margem de contribuição de cada dia do período
// filtrado, comparado com o dia anterior e com o mesmo dia do mês passado.
// Carrega uma janela mais larga que o período (1 mês + 2 dias antes de
// date_from) só pra ter de onde tirar essas duas comparações — não grava
// nada novo, não duplica cálculo de margem (usa o `lucro` já pronto de
// `sales_entries_detail`, igual ao resto do arquivo).
router.get('/lojas/:storeId/dias', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { date_from = '', date_to = '' } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from e date_to são obrigatórios' });

    const d1 = new Date(date_from + 'T00:00:00');
    const janela = new Date(d1.getFullYear(), d1.getMonth() - 1, d1.getDate() - 2);
    const janelaStr = janela.toISOString().slice(0, 10);

    const [detalhe, entries] = await Promise.all([
      loadDetalhe(janelaStr, date_to, storeId),
      loadAds(janelaStr, date_to, storeId),
    ]);

    const porDia = {};
    const getDia = (d) => porDia[d] || (porDia[d] = { faturamento: 0, lucro: 0, ads: 0 });
    detalhe.forEach(r => {
      if (!r.date) return;
      const g = getDia(String(r.date).slice(0, 10));
      g.faturamento += Number(r.faturamento) || 0;
      g.lucro += Number(r.lucro) || 0;
    });
    entries.forEach(e => {
      if (!e.date) return;
      getDia(String(e.date).slice(0, 10)).ads += (Number(e.ads_ml) || 0) + (Number(e.ads_external) || 0);
    });

    const dias = [];
    const cursor = new Date(date_from + 'T00:00:00');
    const fim = new Date(date_to + 'T00:00:00');
    while (cursor <= fim) {
      const dia = cursor.toISOString().slice(0, 10);
      const atual = porDia[dia] || { faturamento: 0, lucro: 0, ads: 0 };
      const ant = porDia[diaAnterior(dia)] || null;
      const mesPassado = porDia[mesmoDiaMesPassado(dia)] || null;
      const lucroDia = atual.lucro - atual.ads; // Ads do dia descontado, mesmo critério do /resumo
      dias.push({
        date: dia,
        faturamento: round2(atual.faturamento),
        lucro: round2(lucroDia),
        lucro_antes_ads: round2(atual.lucro),
        margem_pct: atual.faturamento > 0 ? round2(lucroDia / atual.faturamento * 100) : 0,
        ads: round2(atual.ads),
        faturamento_dia_anterior: ant ? round2(ant.faturamento) : null,
        cresc_dia_anterior_pct: ant ? crescPct(atual.faturamento, ant.faturamento) : null,
        faturamento_mes_passado: mesPassado ? round2(mesPassado.faturamento) : null,
        cresc_mes_passado_pct: mesPassado ? crescPct(atual.faturamento, mesPassado.faturamento) : null,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({ store_id: storeId, dias });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/bi/vendas/curva-abc?date_from&date_to&store_id — classificação
// A/B/C por % acumulado de faturamento, por produto. MESMO limiar de
// GET /api/comparativos/curva-abc (server/src/routes/api.js, Operacional/
// Postgres, só ML — bi.js já referencia essa fonte como canônica, nunca uma
// 2ª fórmula): pct_acum<=80→A, <=95→B, senão C. Fonte aqui é
// sales_entries_detail (Supabase, todos os marketplaces via Metrizap), por
// isso é uma rota própria em vez de reusar a de api.js.
router.get('/curva-abc', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '' } = req.query;
    const rows = await loadDetalhe(date_from, date_to, store_id);
    const produtos = agruparPorProduto(rows).sort((a, b) => b.faturamento - a.faturamento);
    const total = produtos.reduce((s, p) => s + p.faturamento, 0);
    let acum = 0;
    const items = produtos.map(p => {
      acum += p.faturamento;
      const pctAcum = total > 0 ? (acum / total) * 100 : 0;
      const curva = pctAcum <= 80 ? 'A' : pctAcum <= 95 ? 'B' : 'C';
      return { ...p, pct_acum: round2(pctAcum), curva };
    });
    const summary = { A: { count: 0, faturamento: 0 }, B: { count: 0, faturamento: 0 }, C: { count: 0, faturamento: 0 } };
    items.forEach(i => { summary[i.curva].count++; summary[i.curva].faturamento += i.faturamento; });
    res.json({ items, summary, total: round2(total) });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/bi/vendas/logistica?date_from&date_to&store_id — agrupa por
// modalidade de logística (campo `logistica` de sales_entries_detail —
// xd_drop_off/fulfillment/self_service/iMile BR etc., varia por marketplace),
// descontando custo do produto + frete do vendedor, pra ver qual modalidade
// realmente compensa. Nunca recalcula lucro por pedido — soma o `lucro` já
// gravado por venda, igual ao resto do arquivo (ver finance.md).
router.get('/logistica', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '' } = req.query;
    const rows = await loadDetalhe(date_from, date_to, store_id);
    const by = {};
    rows.forEach(r => {
      const key = r.logistica || '(não informado)';
      const g = by[key] || (by[key] = {
        logistica: key, quantidade: 0, faturamento: 0, custo_produto: 0, frete_vendedor: 0, lucro: 0, vendas: 0,
      });
      g.quantidade += Number(r.quantidade) || 0;
      g.faturamento += Number(r.faturamento) || 0;
      g.custo_produto += Number(r.custo_produto) || 0;
      g.frete_vendedor += Number(r.frete_vendedor) || 0;
      g.lucro += Number(r.lucro) || 0;
      g.vendas += 1;
    });
    const modalidades = Object.values(by).map(g => ({
      ...g,
      faturamento: round2(g.faturamento),
      custo_produto: round2(g.custo_produto),
      frete_vendedor: round2(g.frete_vendedor),
      lucro: round2(g.lucro),
      margem_pct: g.faturamento > 0 ? round2(g.lucro / g.faturamento * 100) : 0,
    })).sort((a, b) => b.margem_pct - a.margem_pct);
    res.json({ modalidades });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Alerta de Queda por Produto — compara o período atual vs. o período
// anterior de mesma duração (periodoAnterior, MESMA fórmula já usada em
// /lojas acima) por produto (store_id+sku). Função pura exportada
// (router.detectarQuedasProdutos) pra ser a MESMA fonte usada tanto pela
// rota de leitura da página quanto pelo job agendado do worker.js que manda
// o alerta no Telegram — nunca uma 2ª cópia da comparação (mesmo princípio
// de server/src/reports.js, ver workers.md).
const QUEDA_PRODUTO_ALERTA_PCT = 40; // "queda grande" — mesmo limiar já usado no Rankeamento pra queda de visitas
const QUEDA_PRODUTO_FATURAMENTO_MIN = 100; // ignora produto com faturamento anterior pequeno (ruído estatístico)

async function detectarQuedasProdutos(date_from, date_to, store_id) {
  const anterior = periodoAnterior(date_from, date_to);
  const [atualRows, passadoRows] = await Promise.all([
    loadDetalhe(date_from, date_to, store_id),
    anterior.de ? loadDetalhe(anterior.de, anterior.ate, store_id) : Promise.resolve([]),
  ]);
  // União das chaves dos dois períodos: produto que PAROU de vender (só
  // existe no anterior) é a queda mais grave (−100%) e precisa aparecer.
  const chave = p => `${p.store_id}::${p.sku || p.produto}`;
  const atualByKey = {}, passadoByKey = {};
  agruparPorProduto(atualRows).forEach(p => { atualByKey[chave(p)] = p; });
  agruparPorProduto(passadoRows).forEach(p => { passadoByKey[chave(p)] = p; });

  const produtos = [...new Set([...Object.keys(atualByKey), ...Object.keys(passadoByKey)])].map(k => {
    const at = atualByKey[k] || null, ant = passadoByKey[k] || null;
    const base = at || ant;
    const faturamento = at ? at.faturamento : 0;
    const faturamentoAnterior = ant ? ant.faturamento : 0;
    return {
      store_id: base.store_id, sku: base.sku, produto: base.produto,
      quantidade: at ? at.quantidade : 0, quantidade_anterior: ant ? ant.quantidade : 0,
      faturamento, faturamento_anterior: round2(faturamentoAnterior),
      cresc_pct: faturamentoAnterior > 0 ? round2((faturamento - faturamentoAnterior) / faturamentoAnterior * 100) : null,
    };
  });

  const alertas = produtos
    .filter(p => p.cresc_pct != null && p.cresc_pct <= -QUEDA_PRODUTO_ALERTA_PCT && p.faturamento_anterior >= QUEDA_PRODUTO_FATURAMENTO_MIN)
    .sort((a, b) => a.cresc_pct - b.cresc_pct);

  return { alertas, periodo_anterior: anterior };
}

// GET /api/bi/vendas/alertas-queda?date_from&date_to&store_id
router.get('/alertas-queda', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '' } = req.query;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from e date_to são obrigatórios' });
    const r = await detectarQuedasProdutos(date_from, date_to, store_id);
    res.json(r);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/bi/vendas/pareto?date_from&date_to&store_id — aba "Princípio de
// Pareto": anúncios (store_id + item_id) que somam ≥80% do faturamento. Cálculo
// em server/src/pareto.js (puro, testado em test/pareto.test.js). Mesma base
// das outras abas: sales_entries_detail sem canceladas (loadDetalhe). Carrega
// TODAS as lojas do período pra deduplicar venda importada em 2 lojas e só
// depois aplica o filtro de loja. `faturamento_fonte` (soma crua do filtro) e
// `duplicadas` permitem reconciliar: fonte − duplicadas = total + não atribuído.
router.get('/pareto', async (req, res) => {
  try {
    const { date_from = '', date_to = '', store_id = '' } = req.query;
    const [todas, resumoDiario] = await Promise.all([
      loadDetalhe(date_from, date_to, ''),
      loadAds(date_from, date_to, ''), // sales_entries = resumo diário do Vendas & Custos
    ]);
    const daLoja = rows => (store_id ? rows.filter(r => String(r.store_id) === String(store_id)) : rows);
    const { rows: dedup, removidas } = pareto.deduplicarEntreLojas(todas);
    const fonte = daLoja(todas);
    const remov = daLoja(removidas);
    const base = daLoja(dedup);
    const r = pareto.calcularPareto(base);
    res.json({
      ...r,
      metrica: 'Faturamento (coluna Faturamento do Metrizap, vendas não canceladas)',
      vendas_custos: pareto.conciliarComResumoDiario(daLoja(resumoDiario), base),
      faturamento_fonte: round2(fonte.reduce((s, x) => s + (Number(x.faturamento) || 0), 0)),
      linhas_fonte: fonte.length,
      duplicadas: { linhas: remov.length, faturamento: round2(remov.reduce((s, x) => s + (Number(x.faturamento) || 0), 0)),
        pedidos: [...new Set(remov.map(x => x.pedido))] },
    });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Alerta "dia sem importação" (job checkImportacaoMetrizap do worker, 19:00):
// só CARREGA resumo + detalhe (sem canceladas, mesmo loadDetalhe das abas) +
// lojas ativas da janela e delega o cálculo a importacaoMetrizap.js (puro).
async function verificarImportacaoMetrizap(ontem, janelaDias = importacao.JANELA_DIAS) {
  const de = importacao.somaDias(ontem, -(janelaDias - 1));
  const [resumo, detalhe, lojas] = await Promise.all([
    loadPeriodo('sales_entries', de, ontem, ''),
    loadDetalhe(de, ontem, ''),
    supa.get('/stores?select=id,name,ativa'),
  ]);
  return importacao.verificarImportacao({
    resumo, detalhe, ontem, janelaDias,
    lojas: (Array.isArray(lojas) ? lojas : []).filter(l => l.ativa !== false),
  });
}

router.detectarQuedasProdutos = detectarQuedasProdutos;
router.verificarImportacaoMetrizap = verificarImportacaoMetrizap;
router.QUEDA_PRODUTO_ALERTA_PCT = QUEDA_PRODUTO_ALERTA_PCT;
router.QUEDA_PRODUTO_FATURAMENTO_MIN = QUEDA_PRODUTO_FATURAMENTO_MIN;
module.exports = router;
