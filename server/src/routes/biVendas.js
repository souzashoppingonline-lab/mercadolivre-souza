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

const router = express.Router();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function noPeriodo(dateStr, date_from, date_to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (date_from && d < date_from) return false;
  if (date_to && d > date_to) return false;
  return true;
}

async function loadDetalhe(date_from, date_to, store_id) {
  const rows = await supa.selectRows('sales_entries_detail', 5000, 'date.desc');
  return rows.filter(r =>
    noPeriodo(r.date, date_from, date_to) &&
    (!store_id || String(r.store_id) === String(store_id))
  );
}

async function loadAds(date_from, date_to, store_id) {
  const rows = await supa.selectRows('sales_entries', 5000, 'date.desc');
  return rows.filter(r =>
    noPeriodo(r.date, date_from, date_to) &&
    (!store_id || String(r.store_id) === String(store_id))
  );
}

function agruparPorProduto(rows) {
  const by = {};
  rows.forEach(r => {
    const key = `${r.store_id}::${r.sku || r.produto || '—'}`;
    const g = by[key] || (by[key] = {
      store_id: r.store_id, sku: r.sku || null, produto: null,
      quantidade: 0, faturamento: 0, lucro: 0, vendas: 0,
    });
    if (!g.produto && r.produto) g.produto = r.produto;
    g.quantidade += Number(r.quantidade) || 0;
    g.faturamento += Number(r.faturamento) || 0;
    g.lucro += Number(r.lucro) || 0;
    g.vendas += 1;
  });
  return Object.values(by).map(g => ({
    ...g,
    produto: g.produto || '(sem título)',
    faturamento: round2(g.faturamento),
    lucro: round2(g.lucro),
    margem_pct: g.faturamento > 0 ? round2(g.lucro / g.faturamento * 100) : 0,
  }));
}

const CAMPO_ORDENACAO = { qtd: 'quantidade', faturamento: 'faturamento', lucro: 'lucro', margem: 'margem_pct' };

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
    const custosTotais = s.custo + s.imposto + s.tarifa + s.frete_vendedor + ads;
    const skusDistintos = new Set(detalhe.map(r => `${r.store_id}::${r.sku || r.produto}`)).size;
    res.json({
      total_vendas: detalhe.length,
      skus_distintos: skusDistintos,
      faturamento: round2(s.faturamento),
      lucro: round2(s.lucro),
      margem_pct: s.faturamento > 0 ? round2(s.lucro / s.faturamento * 100) : 0,
      ads: round2(ads),
      roi: custosTotais > 0 ? round2((s.lucro - ads) / custosTotais * 100) : 0,
    });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
