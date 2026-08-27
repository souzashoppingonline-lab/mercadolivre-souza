// Módulo INTELIGÊNCIA DE NEGÓCIO (BI) — análises estratégicas sobre os dados
// OPERACIONAIS (Postgres principal). Montado em /api/bi (só admin — ver MODULES
// em routes/staffAuth.js). Distinto do Financeiro (que lê do Supabase).
// Amazon fica de fora dos números (sandbox/mock inflava) — ver dashboard/kpis.
// Ver .claude/modules.md.
const express = require('express');
const pool = require('../db/pool');
const llm = require('../ai/llm');
const margemNarrativa = require('../ai/margemNarrativa');
// SQL + fórmula de margem, reusadas aqui pra não duplicar (routes/api.js e
// financeService.js também usam este mesmo módulo). Nunca duas fórmulas de
// margem no projeto.
const { VENDA_DETALHE_SELECT, calcularMargemLinha } = require('../vendaMargem');

const router = express.Router();

// Painel Estratégico: um payload único com tudo que a home do BI usa.
// ?period = janela em dias (default 30); ?store_id opcional (filtra por loja).
router.get('/painel', async (req, res) => {
  try {
    const period = Math.min(Math.max(Number(req.query.period) || 30, 1), 365);
    const storeId = String(req.query.store_id || '').trim();
    const amazonId = (await pool.query(`SELECT id FROM marketplaces WHERE code='AMAZON'`)).rows[0]?.id || -1;

    // Datas em SP como EXPRESSÕES SQL inline (period é inteiro validado, seguro).
    const spToday = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
    const curIni = `(${spToday} - ${period - 1})`, curFim = `${spToday}`;
    const prevIni = `(${spToday} - ${2 * period - 1})`, prevFim = `(${spToday} - ${period})`;

    // Cláusula base compartilhada. $1 = amazonId; $2 = store_id (só se houver).
    // As datas entram inline (dIniExpr/dFimExpr são expressões SQL, não valores).
    const base = (dIniExpr, dFimExpr, alias = '') => {
      const p = alias ? alias + '.' : '';
      const params = [amazonId];
      let w = `${p}status <> 'cancelled'
               AND ${p}marketplace_id IS DISTINCT FROM $1
               AND (${p}date_created AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${dIniExpr} AND ${dFimExpr}`;
      if (storeId) { params.push(storeId); w += ` AND ${p}store_id = $${params.length}`; }
      return { w, params };
    };

    const kpiSql = (dIni, dFim) => {
      const { w, params } = base(dIni, dFim);
      return pool.query(
        `SELECT COUNT(*)::int pedidos, COALESCE(SUM(total_amount),0)::numeric receita,
                COALESCE(SUM(quantity),0)::int unidades
           FROM orders WHERE ${w}`, params);
    };

    const [cur, prev] = await Promise.all([kpiSql(curIni, curFim), kpiSql(prevIni, prevFim)]);

    // Série diária (período atual).
    const { w: wDia, params: pDia } = base(curIni, curFim);
    const diaria = await pool.query(
      `SELECT (date_created AT TIME ZONE 'America/Sao_Paulo')::date d,
              COUNT(*)::int pedidos, COALESCE(SUM(total_amount),0)::numeric receita
         FROM orders WHERE ${wDia}
        GROUP BY d ORDER BY d`, pDia);

    // Por canal (ML/Shopee) no período — orders com alias 'o' + join marketplaces.
    const { w: wCanal, params: pCanal } = base(curIni, curFim, 'o');
    const canais = await pool.query(
      `SELECT COALESCE(mk.code,'ML') code, COALESCE(mk.name,'Mercado Livre') name,
              COUNT(o.ml_id)::int pedidos, COALESCE(SUM(o.total_amount),0)::numeric receita
         FROM orders o LEFT JOIN marketplaces mk ON mk.id = o.marketplace_id
        WHERE ${wCanal}
        GROUP BY code, name ORDER BY receita DESC`, pCanal);

    // Top produtos por receita no período.
    const { w: wTop, params: pTop } = base(curIni, curFim);
    const top = await pool.query(
      `SELECT item_id, MAX(title) title, COUNT(*)::int pedidos,
              COALESCE(SUM(quantity),0)::int unidades, COALESCE(SUM(total_amount),0)::numeric receita
         FROM orders WHERE ${wTop} AND item_id IS NOT NULL
        GROUP BY item_id ORDER BY receita DESC LIMIT 10`, pTop);

    // Clientes novos vs recorrentes no período: "novo" = 1ª compra (histórica)
    // caiu dentro da janela; "recorrente" = já comprava antes.
    const { w: wCli, params: pCli } = base(curIni, curFim);
    const clientes = await pool.query(
      `WITH periodo AS (
         SELECT DISTINCT buyer_nickname FROM orders WHERE ${wCli} AND buyer_nickname IS NOT NULL
       )
       SELECT
         COUNT(*) FILTER (WHERE prim.primeira >= ${curIni})::int AS novos,
         COUNT(*) FILTER (WHERE prim.primeira <  ${curIni})::int AS recorrentes
       FROM periodo p
       JOIN LATERAL (
         SELECT MIN((o.date_created AT TIME ZONE 'America/Sao_Paulo')::date) primeira
           FROM orders o
          WHERE o.buyer_nickname = p.buyer_nickname AND o.status <> 'cancelled'
       ) prim ON true`, pCli);

    const n = v => Number(v) || 0;
    const growth = (a, b) => b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0);
    const c = cur.rows[0], pv = prev.rows[0];
    res.json({
      period,
      kpis: {
        receita: n(c.receita), pedidos: n(c.pedidos), unidades: n(c.unidades),
        ticket: n(c.pedidos) ? n(c.receita) / n(c.pedidos) : 0,
        receita_ant: n(pv.receita), pedidos_ant: n(pv.pedidos),
        cresc_receita: growth(n(c.receita), n(pv.receita)),
        cresc_pedidos: growth(n(c.pedidos), n(pv.pedidos)),
      },
      diaria: diaria.rows.map(r => ({ d: r.d, pedidos: n(r.pedidos), receita: n(r.receita) })),
      canais: canais.rows.map(r => ({ code: r.code, name: r.name, pedidos: n(r.pedidos), receita: n(r.receita) })),
      top: top.rows.map(r => ({ item_id: r.item_id, title: r.title, pedidos: n(r.pedidos), unidades: n(r.unidades), receita: n(r.receita) })),
      clientes: { novos: n(clientes.rows[0]?.novos), recorrentes: n(clientes.rows[0]?.recorrentes) },
    });
  } catch (e) {
    console.error('[bi] /painel error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INTELIGÊNCIA DE MARGEM — motor determinístico (sem IA/LLM).
//
// Princípio (pedido explícito do usuário): nunca inventar número. Todo campo
// devolvido aqui vem de agregação real sobre `orders`/`items`/`stores`, com a
// MESMA fórmula de margem do resto do projeto (finance.md). Classificações e
// limiares são regras explícitas e documentadas em business-rules.md — não
// "verdade universal", são ajustáveis, mas nunca uma opinião de IA sem base.
//
// Camada de IA (Fase 2, ver rota /margem/narrativa abaixo): só INTERPRETA em
// texto o que este bloco já calculou — nunca refaz conta financeira.
// ═══════════════════════════════════════════════════════════════════════════

const addDiasISO = (dias) => {
  const d = new Date(); d.setDate(d.getDate() + Math.floor(dias));
  return d.toISOString().slice(0, 10);
};
// Mesmo mapeamento visual de fmtFreteLabel (pages/vendas.html/bi-vendas.html)
// — mantido em sincronia manualmente (é classificação de rótulo, não fórmula
// financeira, então duplicar aqui não fere a regra "nunca duas fórmulas de
// margem"; é só texto de agrupamento).
function logisticaLabel(raw) {
  const l = String(raw || '').toLowerCase();
  if (l.includes('fulfillment')) return 'Full';
  if (l.includes('self_service') || l.includes('flex')) return 'Flex';
  if (l.includes('xd_drop_off') || l.includes('me2') || l.includes('me1') || l.includes('cross_docking')) return 'Mercado Envios';
  if (l.includes('pickup')) return 'Coleta';
  return raw || 'Desconhecido';
}
// Percentil 0..1 de `valor` dentro de `lista` ordenada crescente (rank/  (N-1)).
// N=1 → 1 (não penaliza o único item por falta de comparação).
function percentil(lista, valor) {
  if (lista.length <= 1) return 1;
  let menorOuIgual = 0;
  for (const v of lista) if (v <= valor) menorOuIgual++;
  return (menorOuIgual - 1) / (lista.length - 1);
}
// Segunda-feira da semana ISO de `dataStr` — chave de agrupamento pro
// sparkline de tendência (ver `tendencia_semanal` abaixo).
function semanaChave(dataStr) {
  const d = new Date(dataStr);
  const diaSemana = (d.getDay() + 6) % 7; // 0=segunda ... 6=domingo
  d.setDate(d.getDate() - diaSemana);
  return d.toISOString().slice(0, 10);
}
// % do faturamento de `linhas` (linhas cruas de VENDA_DETALHE_SELECT, já com
// calcularMargemLinha aplicado) que vem de anúncios cuja MC% agregada no
// período fica abaixo de `limiarMcPct` — usado no indicador de "mix" da
// decomposição de causa da variação de margem (ver business-rules.md).
function faturamentoAbaixoDe(linhas, limiarMcPct) {
  const bySku = new Map();
  for (const r of linhas) {
    const k = r.item_id || `sem-anuncio-${r.ml_id}`;
    let s = bySku.get(k);
    if (!s) { s = { fat: 0, margem: 0 }; bySku.set(k, s); }
    s.fat += Number(r.faturamento) || 0;
    s.margem += r.margem;
  }
  let totalFat = 0, fatAbaixo = 0;
  for (const s of bySku.values()) {
    const mc = s.fat > 0 ? (s.margem / s.fat) * 100 : 0;
    totalFat += s.fat;
    if (mc < limiarMcPct) fatAbaixo += s.fat;
  }
  return totalFat > 0 ? (fatAbaixo / totalFat) * 100 : 0;
}

const MC_BAIXA = 15, MC_ALTA = 30;      // pontos percentuais — ver business-rules.md
const AMOSTRA_MINIMA = 3;               // pedidos — abaixo disso, classificação/score viram "amostra pequena" (business-rules.md)
const CENARIOS_REPRECIFICACAO = [3, 5, 10]; // % de aumento de preço simulados na ação REPRECIFICAR

// Núcleo determinístico de /margem, extraído em função própria pra ser
// reusado por /margem/narrativa (a IA nunca recalcula nada — ela só recebe
// este MESMO payload e escreve texto em cima dele).
async function computarMargem(days, storeId) {
  const params = [days];
  let storeFilter = '';
  if (storeId) { params.push(storeId); storeFilter = `AND o.store_id = $${params.length}::bigint`; }

  // Período atual + período anterior de MESMA duração (comparação justa,
  // mesmo princípio do Painel Estratégico — ver finance.md/business-rules.md).
  const buscarPeriodo = async (deslocDias) => {
    const p = [...params];
    const offSql = deslocDias ? `- ${deslocDias}` : '';
    const { rows } = await pool.query(
      `${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled'
         AND o.date_created >= (CURRENT_DATE - $1::int ${offSql})
         AND o.date_created <  (CURRENT_DATE ${offSql} + 1)
         ${storeFilter}
       ORDER BY o.date_created DESC
       LIMIT 20000`,
      p
    );
    return rows.map(calcularMargemLinha);
  };
  // Janela de tendência: SEMPRE os últimos 42 dias (6 semanas), independente
  // do filtro `days` escolhido — a tendência de um SKU não deve encolher só
  // porque o analista filtrou "últimos 7 dias" (ver business-rules.md).
  const buscarTendencia = async () => {
    const p = storeId ? [storeId] : [];
    const filtro = storeId ? `AND o.store_id = $1::bigint` : '';
    const { rows } = await pool.query(
      `${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled'
         AND o.date_created >= (CURRENT_DATE - 41)
         AND o.date_created <  (CURRENT_DATE + 1)
         ${filtro}
       ORDER BY o.date_created DESC
       LIMIT 20000`,
      p
    );
    return rows.map(calcularMargemLinha);
  };
  const [linhasAtual, linhasAnterior, linhasTend] = await Promise.all([
    buscarPeriodo(0),
    buscarPeriodo(days),
    buscarTendencia(),
  ]);

  const somaMargem = (ls) => ls.reduce((s, r) => s + r.margem, 0);
  const somaFat = (ls) => ls.reduce((s, r) => s + Number(r.faturamento || 0), 0);
  const somaCampo = (ls, campo) => ls.reduce((s, r) => s + (Number(r[campo]) || 0), 0);
  const fatAtual = somaFat(linhasAtual), margemAtual = somaMargem(linhasAtual);
  const fatAnterior = somaFat(linhasAnterior), margemAnterior = somaMargem(linhasAnterior);
  const growth = (a, b) => b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0);

  // ── Tendência semanal por SKU (últimas até 6 semanas) ─────────────────
  const porSkuSemana = new Map(); // item_id -> Map(segunda-feira -> {fat, margem})
  for (const r of linhasTend) {
    if (!r.item_id) continue;
    const sem = semanaChave(r.date_created);
    let m = porSkuSemana.get(r.item_id);
    if (!m) { m = new Map(); porSkuSemana.set(r.item_id, m); }
    let s = m.get(sem);
    if (!s) { s = { fat: 0, margem: 0 }; m.set(sem, s); }
    s.fat += Number(r.faturamento) || 0;
    s.margem += r.margem;
  }
  const tendenciaDoSku = (itemId) => {
    const m = porSkuSemana.get(itemId);
    if (!m) return [];
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([semana, v]) => ({ semana, mc_pct: v.fat > 0 ? Number(((v.margem / v.fat) * 100).toFixed(1)) : 0, faturamento: v.fat }));
  };

  // ── Agregação por anúncio (item_id) ───────────────────────────────────
  const bySku = new Map();
  for (const r of linhasAtual) {
    const k = r.item_id || `sem-anuncio-${r.ml_id}`;
    let s = bySku.get(k);
    if (!s) {
      s = {
        item_id: r.item_id, title: r.title, thumbnail: r.thumbnail, conta: r.conta,
        store_id: r.store_id, frete_tipo: r.frete_tipo, estoque_atual: r.estoque_atual,
        faturamento: 0, qtd: 0, pedidos: 0, custo: 0, imposto: 0, tarifa: 0,
        frete_vendedor: 0, frete_comprador: 0, margem: 0,
      };
      bySku.set(k, s);
    }
    s.faturamento += Number(r.faturamento) || 0;
    s.qtd += Number(r.quantity) || 0;
    s.pedidos += 1;
    s.custo += r.custo; s.imposto += r.imposto; s.tarifa += r.tarifa;
    s.frete_vendedor += r.freteVend; s.frete_comprador += Number(r.frete_comprador) || 0;
    s.margem += r.margem;
  }
  let produtos = [...bySku.values()];

  // Faturamento/MC%/participações — sempre em cima do que já foi somado
  // (nunca recalcula um valor que o banco já deu, só combina).
  produtos.forEach(s => {
    s.mc_pct = s.faturamento > 0 ? Number(((s.margem / s.faturamento) * 100).toFixed(2)) : 0;
    s.ticket = s.pedidos > 0 ? s.faturamento / s.pedidos : 0;
    s.participacao_faturamento_pct = fatAtual > 0 ? (s.faturamento / fatAtual) * 100 : 0;
    s.participacao_lucro_pct = margemAtual !== 0 ? (s.margem / margemAtual) * 100 : 0;
    // Amostra pequena (business-rules.md): com poucos pedidos, classificação
    // e score podem não ser representativos (1 venda com prejuízo já vira
    // "Destruidor de margem"). Só um aviso — não muda a conta.
    s.amostra_pequena = s.pedidos < AMOSTRA_MINIMA;
    s.tendencia_semanal = tendenciaDoSku(s.item_id);

    // Estoque & ruptura — mesma fórmula de getRupturaEstoque (reports.js):
    // venda/dia = unidades vendidas no período ÷ dias; dias de estoque =
    // estoque atual ÷ venda/dia. RUPTURA_IMINENTE (≤7d) usa o MESMO limiar
    // já usado ali (dias=7, ver business-rules.md); SAUDÁVEL/EXCESSO são
    // faixas novas desta tela, documentadas em business-rules.md.
    s.venda_dia = s.qtd > 0 ? Number((s.qtd / days).toFixed(2)) : 0;
    if (s.estoque_atual == null || s.venda_dia <= 0) {
      s.dias_estoque = null; s.data_ruptura = null;
      s.status_estoque = s.estoque_atual === 0 ? 'ZERADO' : 'SEM_VENDA_NO_PERIODO';
    } else {
      s.dias_estoque = Math.floor(s.estoque_atual / s.venda_dia);
      s.data_ruptura = addDiasISO(s.dias_estoque);
      s.status_estoque = s.dias_estoque <= 7 ? 'RUPTURA_IMINENTE' : s.dias_estoque <= 60 ? 'SAUDAVEL' : 'EXCESSO';
    }
  });

  // ── Classificação por produto (limiares em business-rules.md) ────────
  // "Alto faturamento" = SKU pertence à Curva A (mesma regra já usada e
  // documentada em /api/comparativos/curva-abc: ≤80% do faturamento
  // ACUMULADO, ordenado do maior pro menor). Por FATIA, não por contagem —
  // um corte por índice (ex.: "top 20% dos SKUs") fica frágil com poucos
  // produtos (facilmente sobra só 1 item acima do corte); por fatia de
  // faturamento se comporta bem com qualquer quantidade de SKUs.
  // Acumula e SÓ DEPOIS confere o corte de 80% — mesma ordem de
  // /api/comparativos/curva-abc (acum += faturamento; pct = acum/total).
  const porFatDesc = [...produtos].sort((a, b) => b.faturamento - a.faturamento);
  let acumulado = 0;
  const altoFaturamentoSet = new Set();
  porFatDesc.forEach(s => {
    acumulado += s.faturamento;
    const pct = fatAtual > 0 ? (acumulado / fatAtual) * 100 : 100;
    if (pct <= 80) altoFaturamentoSet.add(s.item_id || s.title);
  });
  // Portfólio pequeno/concentrado: o próprio líder já soma >80% sozinho, e
  // a regra acima nunca inclui ninguém (matematicamente correta, mas
  // esconde justo o SKU mais relevante do catálogo). Garante que o líder
  // por faturamento sempre entra — é definicionalmente quem mais fatura.
  if (!altoFaturamentoSet.size && porFatDesc.length) {
    altoFaturamentoSet.add(porFatDesc[0].item_id || porFatDesc[0].title);
  }
  produtos.forEach(s => {
    const altoFaturamento = altoFaturamentoSet.has(s.item_id || s.title);
    if (s.margem < 0) s.classificacao = 'PREJUIZO';
    else if (altoFaturamento && s.mc_pct >= MC_ALTA) s.classificacao = 'ESTRELA';
    else if (altoFaturamento && s.mc_pct < MC_BAIXA) s.classificacao = 'VOLUME_BAIXA_MARGEM';
    else if (!altoFaturamento && s.mc_pct >= MC_ALTA) s.classificacao = 'ALTA_MARGEM_BAIXO_VOLUME';
    else if (s.mc_pct < MC_BAIXA) s.classificacao = 'DESTRUIDOR_MARGEM';
    else s.classificacao = 'NEUTRO';
  });

  // ── Score 0-100 (fórmula em business-rules.md, sempre com breakdown) ──
  const mcs = produtos.map(s => s.mc_pct), fats = produtos.map(s => s.faturamento), lucros = produtos.map(s => s.margem);
  produtos.forEach(s => {
    const pMc = percentil(mcs, s.mc_pct), pFat = percentil(fats, s.faturamento), pLucro = percentil(lucros, s.margem);
    const ptsEstoque = s.status_estoque === 'SAUDAVEL' ? 15
      : s.status_estoque === 'RUPTURA_IMINENTE' ? 5
      : s.status_estoque === 'EXCESSO' ? 8
      : 12;   // sem dado de venda/estoque suficiente → neutro, não penaliza
    const breakdown = {
      margem: Math.round(pMc * 35), faturamento: Math.round(pFat * 25),
      lucro: Math.round(pLucro * 25), estoque: ptsEstoque,
    };
    s.score = Math.max(0, Math.min(100, breakdown.margem + breakdown.faturamento + breakdown.lucro + breakdown.estoque));
    s.score_detalhe = breakdown;
  });

  produtos.sort((a, b) => b.faturamento - a.faturamento);

  // ── Portfólio: faixas de MC% e concentração ───────────────────────────
  const FAIXAS = [
    { min: -Infinity, max: 10, label: '< 10%' },
    { min: 10, max: 15, label: '10–15%' },
    { min: 15, max: 20, label: '15–20%' },
    { min: 20, max: 30, label: '20–30%' },
    { min: 30, max: 50, label: '30–50%' },
    { min: 50, max: Infinity, label: '> 50%' },
  ];
  const bandas = FAIXAS.map(f => {
    const ls = produtos.filter(s => s.mc_pct >= f.min && s.mc_pct < f.max);
    const fat = ls.reduce((s, p) => s + p.faturamento, 0);
    return { faixa: f.label, qtd_skus: ls.length, faturamento: fat, pct_faturamento: fatAtual > 0 ? (fat / fatAtual) * 100 : 0 };
  });
  const top10 = produtos.slice(0, 10);
  const concentracao = {
    top10_faturamento: top10.reduce((s, p) => s + p.faturamento, 0),
    top10_pct_faturamento: fatAtual > 0 ? (top10.reduce((s, p) => s + p.faturamento, 0) / fatAtual) * 100 : 0,
    top10_pct_lucro: margemAtual !== 0 ? (top10.reduce((s, p) => s + p.margem, 0) / margemAtual) * 100 : 0,
    total_skus: produtos.length,
  };

  // ── Frete & Tarifa: % da receita, por tipo de envio e por conta ───────
  const agruparFreteTarifa = (chaveFn) => {
    const m = new Map();
    produtos.forEach(s => {
      const k = chaveFn(s);
      const a = m.get(k) || { chave: k, faturamento: 0, frete_vendedor: 0, tarifa: 0 };
      a.faturamento += s.faturamento; a.frete_vendedor += s.frete_vendedor; a.tarifa += s.tarifa;
      m.set(k, a);
    });
    return [...m.values()].map(a => ({
      ...a,
      frete_pct: a.faturamento > 0 ? (a.frete_vendedor / a.faturamento) * 100 : 0,
      tarifa_pct: a.faturamento > 0 ? (a.tarifa / a.faturamento) * 100 : 0,
    })).sort((a, b) => b.faturamento - a.faturamento);
  };
  const freteTarifa = {
    por_logistica: agruparFreteTarifa(s => logisticaLabel(s.frete_tipo)),
    por_conta: agruparFreteTarifa(s => s.conta || '—'),
  };

  // ── Decomposição da variação de margem (atual vs. período anterior) ───
  // Identidade exata: margem = faturamento − custo − imposto − tarifa −
  // frete_comprador − frete_vendedor. Logo Δmargem se decompõe SEM RESTO em
  // Δfaturamento − Δcusto − Δimposto − Δtarifa − Δfrete_comprador −
  // Δfrete_vendedor — nenhum componente é estimado, é a própria fórmula
  // (finance.md) aplicada à diferença entre os dois períodos.
  // O indicador de "mix" é separado (não entra na soma acima, pra não
  // dividir a mesma variação duas vezes): mede se o faturamento do período
  // ficou mais concentrado em SKUs de MC% baixa, mesmo que cada SKU
  // individualmente não tenha mudado — ver business-rules.md.
  const dFat = fatAtual - fatAnterior;
  const dCusto = somaCampo(linhasAtual, 'custo') - somaCampo(linhasAnterior, 'custo');
  const dImposto = somaCampo(linhasAtual, 'imposto') - somaCampo(linhasAnterior, 'imposto');
  const dTarifa = somaCampo(linhasAtual, 'tarifa') - somaCampo(linhasAnterior, 'tarifa');
  const dFreteVend = somaCampo(linhasAtual, 'freteVend') - somaCampo(linhasAnterior, 'freteVend');
  const dFreteComp = somaCampo(linhasAtual, 'frete_comprador') - somaCampo(linhasAnterior, 'frete_comprador');
  const dMargem = margemAtual - margemAnterior;
  const componentes = [
    { fator: 'faturamento', label: 'Variação de faturamento', contribuicao: dFat },
    { fator: 'custo', label: 'Variação de custo', contribuicao: -dCusto },
    { fator: 'imposto', label: 'Variação de imposto', contribuicao: -dImposto },
    { fator: 'tarifa', label: 'Variação de tarifa ML', contribuicao: -dTarifa },
    { fator: 'frete_vendedor', label: 'Variação de frete do vendedor', contribuicao: -dFreteVend },
    { fator: 'frete_comprador', label: 'Variação de frete do comprador', contribuicao: -dFreteComp },
  ].map(c => ({ ...c, pct_da_variacao: dMargem !== 0 ? (c.contribuicao / dMargem) * 100 : 0 }))
    .sort((a, b) => Math.abs(b.contribuicao) - Math.abs(a.contribuicao));
  const causaVariacao = {
    delta_margem: dMargem,
    componentes,
    mix: {
      pct_faturamento_baixa_margem_atual: faturamentoAbaixoDe(linhasAtual, MC_BAIXA),
      pct_faturamento_baixa_margem_anterior: faturamentoAbaixoDe(linhasAnterior, MC_BAIXA),
      limiar_mc_pct: MC_BAIXA,
    },
  };
  causaVariacao.mix.delta_pp = causaVariacao.mix.pct_faturamento_baixa_margem_atual - causaVariacao.mix.pct_faturamento_baixa_margem_anterior;

  // ── Ações recomendadas (regras explícitas, cada uma com premissa) ────
  // Impacto sempre marcado como ESTIMATIVA com a premissa usada — nunca
  // como previsão garantida (pedido explícito do usuário).
  const acoes = [];
  produtos.forEach(s => {
    if (s.classificacao === 'PREJUIZO') {
      acoes.push({
        tipo: 'PAUSAR_OU_RENEGOCIAR', prioridade: 'ALTA', item_id: s.item_id, title: s.title,
        problema: `Margem de contribuição negativa (${s.mc_pct.toFixed(1)}%) no período.`,
        evidencia: `${s.pedidos} pedido(s), R$ ${s.faturamento.toFixed(2)} de faturamento, prejuízo de R$ ${Math.abs(s.margem).toFixed(2)}.`,
        acao: 'Pausar o anúncio ou renegociar custo/frete/tarifa antes de continuar vendendo.',
        impacto_estimado: Math.abs(s.margem),
        esforco: 'BAIXO', confianca: s.pedidos >= 5 ? 'ALTA' : 'MEDIA',
        premissa: 'Impacto = prejuízo já realizado no período; pausar evita repetir o mesmo prejuízo no próximo período de mesma duração.',
      });
    } else if (s.classificacao === 'VOLUME_BAIXA_MARGEM' || s.classificacao === 'DESTRUIDOR_MARGEM') {
      // Simulação multi-cenário: tarifa e imposto são % do valor da venda,
      // então escalam com o preço; custo do produto e frete são fixos por
      // unidade, não escalam. Volume assumido CONSTANTE em todos os
      // cenários — premissa explícita, não é previsão (business-rules.md).
      const baseCalc = s.faturamento - s.imposto - s.tarifa;
      const cenarios = CENARIOS_REPRECIFICACAO.map(pct => ({
        aumento_pct: pct,
        impacto_estimado: Math.max(0, (pct / 100) * baseCalc),
      }));
      const cenario5 = cenarios.find(c => c.aumento_pct === 5) || cenarios[0];
      acoes.push({
        tipo: 'REPRECIFICAR', prioridade: s.classificacao === 'VOLUME_BAIXA_MARGEM' ? 'ALTA' : 'MEDIA',
        item_id: s.item_id, title: s.title,
        problema: `MC de ${s.mc_pct.toFixed(1)}% (abaixo de ${MC_BAIXA}%) ${s.classificacao === 'VOLUME_BAIXA_MARGEM' ? 'com alto volume' : 'no período'}.`,
        evidencia: `${s.pedidos} pedido(s), R$ ${s.faturamento.toFixed(2)} de faturamento, contribuição de apenas R$ ${s.margem.toFixed(2)}.`,
        acao: 'Testar aumento de preço.',
        impacto_estimado: cenario5.impacto_estimado,   // mantém o cenário de 5% como referência (compat./ordenação)
        cenarios,
        esforco: 'BAIXO', confianca: s.pedidos >= 10 ? 'ALTA' : s.pedidos >= 3 ? 'MEDIA' : 'BAIXA',
        premissa: 'Volume constante; tarifa/imposto escalam com o preço (são %); custo e frete do vendedor ficam fixos.',
      });
    } else if (s.classificacao === 'ALTA_MARGEM_BAIXO_VOLUME') {
      acoes.push({
        tipo: 'AUMENTAR_EXPOSICAO', prioridade: 'MEDIA', item_id: s.item_id, title: s.title,
        problema: `MC alta (${s.mc_pct.toFixed(1)}%) mas só ${s.participacao_faturamento_pct.toFixed(1)}% do faturamento do período.`,
        evidencia: `${s.pedidos} pedido(s) no período, R$ ${s.margem.toFixed(2)} de contribuição.`,
        acao: 'Aumentar exposição (Ads, posição no anúncio, kit) — margem já comprova que vale investir em mais volume.',
        impacto_estimado: s.margem,   // dobrar o volume ≈ dobrar a contribuição atual, mantendo MC%
        esforco: 'MEDIO', confianca: s.pedidos >= 5 ? 'MEDIA' : 'BAIXA',
        premissa: 'Impacto = contribuição atual, assumindo que dobrar o volume (meta da ação) mantém a mesma MC%.',
      });
    }
    if (s.status_estoque === 'RUPTURA_IMINENTE' && s.margem > 0) {
      acoes.push({
        tipo: 'REPOR_ESTOQUE', prioridade: s.dias_estoque <= 3 ? 'ALTA' : 'MEDIA', item_id: s.item_id, title: s.title,
        problema: `Estoque acaba em ~${s.dias_estoque} dia(s) (ruptura estimada em ${s.data_ruptura}).`,
        evidencia: `${s.estoque_atual} un. em estoque, vendendo ${s.venda_dia}/dia, MC ${s.mc_pct.toFixed(1)}%.`,
        acao: 'Repor estoque antes da ruptura — produto está vendendo e dando margem positiva.',
        impacto_estimado: s.venda_dia * 7 * (s.pedidos > 0 ? s.margem / s.qtd : 0),
        esforco: 'MEDIO', confianca: s.qtd >= 5 ? 'ALTA' : 'MEDIA',
        premissa: 'Impacto = contribuição perdida em ~7 dias de ruptura, na mesma velocidade de venda do período.',
      });
    }
    if (s.faturamento > 0 && (s.frete_vendedor / s.faturamento) > 0.15) {
      acoes.push({
        tipo: 'REVISAR_FRETE', prioridade: 'MEDIA', item_id: s.item_id, title: s.title,
        problema: `Frete do vendedor é ${((s.frete_vendedor / s.faturamento) * 100).toFixed(1)}% da receita deste anúncio.`,
        evidencia: `R$ ${s.frete_vendedor.toFixed(2)} de frete sobre R$ ${s.faturamento.toFixed(2)} de faturamento.`,
        acao: 'Reavaliar logística (Full/Flex), embalagem/peso, ou reposicionar preço considerando o frete.',
        impacto_estimado: null,
        esforco: 'MEDIO', confianca: 'MEDIA',
        premissa: 'Sem estimativa de R$ — depende de qual alternativa de frete/preço for escolhida.',
      });
    }
  });
  acoes.sort((a, b) => (b.impacto_estimado || 0) - (a.impacto_estimado || 0));
  const acoesTop = acoes.slice(0, 10);

  return {
    periodo: { dias: days, de: addDiasISO(-days + 1), ate: addDiasISO(0) },
    resumo: {
      faturamento: fatAtual, margem: margemAtual,
      mc_pct: fatAtual > 0 ? (margemAtual / fatAtual) * 100 : 0,
      pedidos: linhasAtual.length,
      cresc_faturamento_pct: growth(fatAtual, fatAnterior),
      cresc_margem_pct: growth(margemAtual, margemAnterior),
      skus_prejuizo: produtos.filter(s => s.classificacao === 'PREJUIZO').length,
      skus_ruptura_iminente: produtos.filter(s => s.status_estoque === 'RUPTURA_IMINENTE').length,
      causa_variacao: causaVariacao,
    },
    produtos,
    bandas_margem: bandas,
    concentracao,
    frete_tarifa: freteTarifa,
    acoes: acoesTop,
  };
}

router.get('/margem', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const storeId = String(req.query.store_id || '').trim();
    res.json(await computarMargem(days, storeId));
  } catch (e) {
    console.error('[bi] /margem error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bi/margem/narrativa — Fase 2: camada de IA (LLM) que só
// INTERPRETA em português o JSON já calculado por computarMargem() acima.
// Síncrona, sob demanda (mesmo padrão de /analise/produtos/:id/analisar) —
// nunca roda sozinha, o analista clica um botão porque tem custo de token.
// A IA nunca recebe o portfólio inteiro (custo/tokens) — só um resumo com o
// que ela precisa pra escrever causa raiz + "o que eu faria agora".
router.post('/margem/narrativa', async (req, res) => {
  try {
    if (!llm.isConfigured()) {
      return res.status(503).json({ error: 'IA não configurada — cole a chave ANTHROPIC_API_KEY no .env do servidor e reinicie.' });
    }
    const days = Math.min(Math.max(Number(req.body.days || req.query.days) || 30, 1), 365);
    const storeId = String(req.body.store_id || req.query.store_id || '').trim();
    const payload = await computarMargem(days, storeId);

    const resumirProduto = p => ({
      title: p.title, item_id: p.item_id, classificacao: p.classificacao,
      faturamento: Number(p.faturamento.toFixed(2)), margem: Number(p.margem.toFixed(2)),
      mc_pct: p.mc_pct, pedidos: p.pedidos, amostra_pequena: p.amostra_pequena,
      status_estoque: p.status_estoque, dias_estoque: p.dias_estoque, data_ruptura: p.data_ruptura,
    });
    const contexto = {
      periodo: payload.periodo,
      resumo: payload.resumo,
      produtos_criticos: payload.produtos
        .filter(p => ['PREJUIZO', 'DESTRUIDOR_MARGEM', 'VOLUME_BAIXA_MARGEM'].includes(p.classificacao))
        .slice(0, 15).map(resumirProduto),
      produtos_estrela: payload.produtos.filter(p => p.classificacao === 'ESTRELA').slice(0, 5).map(resumirProduto),
      ruptura_iminente: payload.produtos.filter(p => p.status_estoque === 'RUPTURA_IMINENTE').slice(0, 10).map(resumirProduto),
      acoes_prioritarias: payload.acoes.slice(0, 8).map(a => ({
        tipo: a.tipo, title: a.title, problema: a.problema, impacto_estimado: a.impacto_estimado, prioridade: a.prioridade,
      })),
    };
    const narrativa = await margemNarrativa.gerarNarrativa(contexto);
    res.json({ ok: true, narrativa, periodo: payload.periodo });
  } catch (e) {
    if (e.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    console.error('[bi] /margem/narrativa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
