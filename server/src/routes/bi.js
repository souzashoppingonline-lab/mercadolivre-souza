// Módulo INTELIGÊNCIA DE NEGÓCIO (BI) — análises estratégicas sobre os dados
// OPERACIONAIS (Postgres principal). Montado em /api/bi (só admin — ver MODULES
// em routes/staffAuth.js). Distinto do Financeiro (que lê do Supabase).
// Amazon fica de fora dos números (sandbox/mock inflava) — ver dashboard/kpis.
// Ver .claude/modules.md.
const express = require('express');
const pool = require('../db/pool');
const { cached } = require('../db/cached');
const llm = require('../ai/llm');
const margemNarrativa = require('../ai/margemNarrativa');
// Fonte de verdade dos estágios de rankeamento (fase de ranking_ads) — nunca
// um 2º cadastro/lógica de estágio aqui, só leitura (ver rankeamento.md).
const ranking = require('../ranking');
// SQL + fórmula de margem, reusadas aqui pra não duplicar (routes/api.js e
// financeService.js também usam este mesmo módulo). Nunca duas fórmulas de
// margem no projeto.
const { VENDA_DETALHE_SELECT, calcularMargemLinha, buscarImpostoFlexAtivo, buscarFreteMotoboy } = require('../vendaMargem');

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
// Soma dias a uma data ISO (YYYY-MM-DD) já conhecida — usa UTC de propósito
// (são datas de calendário, não timestamp; não precisa de fuso) pra derivar
// o período ANTERIOR a partir de um período explícito (`date_from`/`date_to`).
const addDiasStr = (iso, dias) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.floor(dias));
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

// "O que mudou" (Visão Geral): maior alta/queda por SKU entre período atual
// e anterior, pros 5 campos pedidos (faturamento/margem/frete/tarifa/qtd).
// `atualMap`/`anteriorMap` são os Maps item_id -> {faturamento,margem,
// frete_vendedor,tarifa,qtd} (bySku/bySkuAnterior). SKU que só existe num
// dos dois períodos entra com o lado ausente = 0 (ex.: produto novo que
// começou a vender é, de fato, "maior aumento de faturamento" válido).
function calcularMudancas(atualMap, anteriorMap) {
  const chaves = new Set([...atualMap.keys(), ...anteriorMap.keys()]);
  const linhas = [...chaves].map(k => {
    const a = atualMap.get(k), b = anteriorMap.get(k);
    const base = a || b;
    return {
      item_id: base.item_id, title: base.title,
      faturamento_atual: a?.faturamento || 0, faturamento_anterior: b?.faturamento || 0,
      margem_atual: a?.margem || 0, margem_anterior: b?.margem || 0,
      frete_vendedor_atual: a?.frete_vendedor || 0, frete_vendedor_anterior: b?.frete_vendedor || 0,
      tarifa_atual: a?.tarifa || 0, tarifa_anterior: b?.tarifa || 0,
      qtd_atual: a?.qtd || 0, qtd_anterior: b?.qtd || 0,
    };
  });
  const maior = (campo, direcao) => {
    let melhor = null, melhorDelta = null;
    for (const l of linhas) {
      const delta = l[`${campo}_atual`] - l[`${campo}_anterior`];
      const bate = direcao === 'alta' ? (melhorDelta === null || delta > melhorDelta) : (melhorDelta === null || delta < melhorDelta);
      if (bate) { melhorDelta = delta; melhor = l; }
    }
    if (!melhor || melhorDelta === 0) return null; // nada mudou de fato — não inventa um "destaque" de delta 0
    return { item_id: melhor.item_id, title: melhor.title, valor_atual: melhor[`${campo}_atual`], valor_anterior: melhor[`${campo}_anterior`], delta: melhorDelta };
  };
  return {
    maior_aumento_faturamento: maior('faturamento', 'alta'),
    maior_queda_faturamento: maior('faturamento', 'queda'),
    maior_aumento_margem: maior('margem', 'alta'),
    maior_queda_margem: maior('margem', 'queda'),
    maior_aumento_frete: maior('frete_vendedor', 'alta'),
    maior_aumento_tarifa: maior('tarifa', 'alta'),
    maior_aumento_pedidos: maior('qtd', 'alta'),
    maior_queda_pedidos: maior('qtd', 'queda'),
  };
}

// Interpolação linear com clamp — base de todos os sub-scores da Saúde do
// Negócio abaixo. v fora de [x0,x1] satura em y0/y1 (nunca extrapola).
function escalaLinear(v, x0, y0, x1, y1) {
  if (x1 === x0) return y0;
  const t = Math.min(1, Math.max(0, (v - x0) / (x1 - x0)));
  return y0 + t * (y1 - y0);
}

const MC_BAIXA = 15, MC_ALTA = 30;      // pontos percentuais — ver business-rules.md
const AMOSTRA_MINIMA = 3;               // pedidos — abaixo disso, classificação/score viram "amostra pequena" (business-rules.md)
const CENARIOS_REPRECIFICACAO = [3, 5, 10]; // % de aumento de preço simulados na ação REPRECIFICAR

// ── Saúde do Negócio (Visão Geral): score 0-100, 6 sub-scores de peso igual
// (100/6 cada), 100% determinístico — nenhum passa por IA. Fórmulas e
// limiares documentados em business-rules.md, ajustáveis, não "verdade
// universal". Ordem de prioridade do próprio usuário (lucro > margem >
// eficiência > capital > crescimento > faturamento) — por isso rentabilidade
// usa MC% (não faturamento) e crescimento usa a variação de MARGEM, não de
// faturamento.
function scoreRentabilidade(mcPct) {
  if (mcPct <= 0) return 0;
  if (mcPct < MC_BAIXA) return escalaLinear(mcPct, 0, 0, MC_BAIXA, 50);
  if (mcPct < MC_ALTA) return escalaLinear(mcPct, MC_BAIXA, 50, MC_ALTA, 100);
  return 100;
}
function scoreCrescimento(crescMargemPct) {
  if (crescMargemPct <= -20) return 0;
  if (crescMargemPct < 0) return escalaLinear(crescMargemPct, -20, 0, 0, 50);
  if (crescMargemPct < 20) return escalaLinear(crescMargemPct, 0, 50, 20, 100);
  return 100;
}
function scoreLogistica(logisticaPct) {
  if (logisticaPct <= 10) return 100;
  if (logisticaPct < 25) return escalaLinear(logisticaPct, 10, 100, 25, 50);
  if (logisticaPct < 40) return escalaLinear(logisticaPct, 25, 50, 40, 0);
  return 0;
}
function scoreEstoque(produtos) {
  const aplicaveis = produtos.filter(p => p.dias_estoque != null); // só quem tem venda/dia calculável
  if (!aplicaveis.length) return 100; // sem dado suficiente → neutro, não penaliza
  const saudaveis = aplicaveis.filter(p => p.status_estoque === 'SAUDAVEL').length;
  return (saudaveis / aplicaveis.length) * 100;
}
function scoreConcentracao(concentracao) {
  if (concentracao.total_skus <= 10) return 100; // catálogo pequeno: concentração é matematicamente inevitável, não é risco
  const p = concentracao.top10_pct_faturamento;
  if (p <= 50) return 100;
  if (p < 80) return escalaLinear(p, 50, 100, 80, 40);
  return escalaLinear(Math.min(p, 100), 80, 40, 100, 0);
}
function scoreComercial(produtos, fatAtual) {
  if (fatAtual <= 0) return 100;
  const SAUDAVEIS = new Set(['ESTRELA', 'ALTA_MARGEM_BAIXO_VOLUME', 'NEUTRO']);
  const fatSaudavel = produtos.filter(p => SAUDAVEIS.has(p.classificacao)).reduce((s, p) => s + p.faturamento, 0);
  return (fatSaudavel / fatAtual) * 100;
}
function calcularSaude({ mcPct, crescMargemPct, produtos, fatAtual, linhasAtual, somaCampoFn, concentracao }) {
  const logisticaPct = fatAtual > 0 ? ((somaCampoFn(linhasAtual, 'freteVend') + somaCampoFn(linhasAtual, 'tarifa')) / fatAtual) * 100 : 0;
  const subscores = {
    rentabilidade: Math.round(scoreRentabilidade(mcPct)),
    crescimento: Math.round(scoreCrescimento(crescMargemPct)),
    eficiencia_logistica: Math.round(scoreLogistica(logisticaPct)),
    saude_estoque: Math.round(scoreEstoque(produtos)),
    concentracao_portfolio: Math.round(scoreConcentracao(concentracao)),
    eficiencia_comercial: Math.round(scoreComercial(produtos, fatAtual)),
  };
  const score = Math.round(Object.values(subscores).reduce((s, v) => s + v, 0) / 6);
  return { score, subscores };
}

// Núcleo determinístico de /margem, extraído em função própria pra ser
// reusado por /margem/narrativa (a IA nunca recalcula nada — ela só recebe
// este MESMO payload e escreve texto em cima dele).
//
// Período: ou `days` (padrão, N dias terminando hoje — comportamento
// original) ou `dateFrom`/`dateTo` explícitos (Hoje/Ontem/Mês atual/Mês
// anterior/período personalizado, resolvidos no frontend em datas — ver
// business-rules.md). De qualquer forma, sempre compara com um período
// ANTERIOR de duração IGUAL, imediatamente antes do início do atual.
async function computarMargem({ days, storeId, dateFrom, dateTo, categoryId } = {}) {
  let curIni, curFim;
  if (dateFrom && dateTo) { curIni = dateFrom; curFim = dateTo; }
  else { curFim = addDiasISO(0); curIni = addDiasISO(-(days - 1)); }
  const duracaoDias = Math.round((new Date(curFim + 'T00:00:00Z') - new Date(curIni + 'T00:00:00Z')) / 86400000) + 1;
  const prevFim = addDiasStr(curIni, -1);
  const prevIni = addDiasStr(prevFim, -(duracaoDias - 1));
  const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);

  const buscarPeriodo = async (dIni, dFim, marcador) => {
    const p = [dIni, dFim];
    let filtro = '';
    if (storeId) { p.push(storeId); filtro += ` AND o.store_id = $${p.length}::bigint`; }
    if (categoryId) { p.push(categoryId); filtro += ` AND i.category_id = $${p.length}`; }
    const { rows } = await pool.query(
      `-- ${marcador}
       ${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled'
         AND o.date_created >= $1::date
         AND o.date_created <  ($2::date + 1)
         ${filtro}
       ORDER BY o.date_created DESC
       LIMIT 20000`,
      p
    );
    return rows.map(r => calcularMargemLinha(r, impostoFlexAtivo, freteMotoboy));
  };
  // Janela de tendência: SEMPRE 42 dias (6 semanas) terminando no FIM do
  // período selecionado (não necessariamente hoje — analisar "mês anterior"
  // deve mostrar tendência até o fim daquele mês, não do presente) —
  // independente da duração do período escolhido (business-rules.md).
  const buscarTendencia = () => buscarPeriodo(addDiasStr(curFim, -41), curFim, 'tendencia');

  const [linhasAtual, linhasAnterior, linhasTend] = await Promise.all([
    buscarPeriodo(curIni, curFim, 'periodo-atual'),
    buscarPeriodo(prevIni, prevFim, 'periodo-anterior'),
    buscarTendencia(),
  ]);
  // `days` (parâmetro) é reatribuído pra `duracaoDias` real — todo o resto da
  // função (venda/dia, `periodo.dias` na resposta) já usa a variável `days`,
  // então isso propaga a duração correta tanto no modo `days=N` quanto no
  // modo `dateFrom`/`dateTo` sem duplicar a conta em dois lugares.
  days = duracaoDias;

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
        store_id: r.store_id, frete_tipo: r.frete_tipo, estoque_atual: r.estoque_atual, category_id: r.category_id,
        // Custo UNITÁRIO da venda mais recente (linhasAtual vem ORDER BY
        // date_created DESC — a 1ª linha vista pra este item_id é a mais
        // nova). `r.custo` aqui já é o total da linha (unit×qty, aplicado
        // por calcularMargemLinha) — reverte a multiplicação, não lê
        // items.cost de novo (evita 2ª fonte do mesmo dado). Usado pra
        // "capital parado" (Fase E) — só existe se o item vendeu no
        // período (mesma limitação que estoque_atual/dias_estoque já têm).
        custo_unitario: Number(r.custo) / (Number(r.quantity) || 1),
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

  // Agregação por anúncio do período ANTERIOR (só o essencial — usada por
  // "O que mudou" abaixo, não vira card próprio de produto).
  const bySkuAnterior = new Map();
  for (const r of linhasAnterior) {
    const k = r.item_id || `sem-anuncio-${r.ml_id}`;
    let s = bySkuAnterior.get(k);
    if (!s) { s = { item_id: r.item_id, title: r.title, faturamento: 0, margem: 0, frete_vendedor: 0, tarifa: 0, qtd: 0 }; bySkuAnterior.set(k, s); }
    s.faturamento += Number(r.faturamento) || 0;
    s.margem += r.margem;
    s.frete_vendedor += r.freteVend;
    s.tarifa += r.tarifa;
    s.qtd += Number(r.quantity) || 0;
  }

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

  const mcPctAtual = fatAtual > 0 ? (margemAtual / fatAtual) * 100 : 0;
  const crescMargemPct = growth(margemAtual, margemAnterior);
  const mudancas = calcularMudancas(bySku, bySkuAnterior);
  const saude = calcularSaude({ mcPct: mcPctAtual, crescMargemPct, produtos, fatAtual, linhasAtual, somaCampoFn: somaCampo, concentracao });

  return {
    periodo: { dias: days, de: curIni, ate: curFim },
    resumo: {
      faturamento: fatAtual, margem: margemAtual,
      mc_pct: mcPctAtual,
      pedidos: linhasAtual.length,
      cresc_faturamento_pct: growth(fatAtual, fatAnterior),
      cresc_margem_pct: crescMargemPct,
      skus_prejuizo: produtos.filter(s => s.classificacao === 'PREJUIZO').length,
      skus_ruptura_iminente: produtos.filter(s => s.status_estoque === 'RUPTURA_IMINENTE').length,
      causa_variacao: causaVariacao,
    },
    saude,
    mudancas,
    produtos,
    bandas_margem: bandas,
    concentracao,
    frete_tarifa: freteTarifa,
    acoes: acoesTop,
  };
}

// Lê days/store_id/date_from/date_to/category_id de uma query string, com
// os mesmos limites/validação nos dois pontos de entrada (GET /margem e
// POST /margem/narrativa) — nunca duas cópias da validação.
function parseMargemParams(q) {
  const storeId = String(q.store_id || '').trim();
  const categoryId = String(q.category_id || '').trim();
  const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const temIntervalo = dataValida(q.date_from) && dataValida(q.date_to);
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  return {
    days,
    storeId,
    categoryId,
    dateFrom: temIntervalo ? q.date_from : null,
    dateTo: temIntervalo ? q.date_to : null,
  };
}

router.get('/margem', async (req, res) => {
  try {
    res.json(await computarMargem(parseMargemParams(req.query)));
  } catch (e) {
    console.error('[bi] /margem error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const STATUS_ACAO_VALIDOS = ['pendente', 'em_andamento', 'concluida', 'descartada'];

// GET /api/bi/margem/acoes-status — Fase F: status manual das Ações
// Recomendadas (business_insights, migrate-v83.sql). As ações continuam
// 100% recalculadas a cada request (nunca persistidas); só o status/nota
// que a analista registrou é persistido, chaveado por (item_id, tipo) —
// identidade estável entre recálculos de período. Tabela é pequena (1 linha
// por ação já vista), devolve tudo de uma vez — o cliente casa localmente
// com `acoes[]` do payload de /margem, sem N chamadas por ação.
router.get('/margem/acoes-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT item_id, tipo, status, nota, updated_by, updated_at, concluida_em FROM business_insights`
    );
    res.json({ status: rows });
  } catch (e) {
    console.error('[bi] /margem/acoes-status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/bi/margem/acoes-status — upsert do status de UMA ação.
// Nunca infere resultado/efeito real — só grava o que a pessoa marcou
// manualmente. `concluida_em` (v87) é só um CARIMBO de quando entrou em
// 'concluida' (zerado ao sair de novo) — o efeito antes×depois em si é
// recalculado a cada request em /margem/acoes-feedback, nunca congelado
// aqui (mesmo princípio de nunca persistir "verdade" derivável, já usado
// pras próprias ações).
router.patch('/margem/acoes-status', async (req, res) => {
  try {
    const { item_id, tipo, status, nota } = req.body || {};
    if (!item_id || !tipo) return res.status(400).json({ error: 'item_id e tipo são obrigatórios' });
    if (!STATUS_ACAO_VALIDOS.includes(status)) {
      return res.status(400).json({ error: `status inválido — use um de: ${STATUS_ACAO_VALIDOS.join(', ')}` });
    }
    const updatedBy = req.staffUser?.username || null;
    const { rows } = await pool.query(
      `INSERT INTO business_insights (item_id, tipo, status, nota, updated_by, updated_at, concluida_em)
       VALUES ($1, $2, $3, $4, $5, now(), CASE WHEN $3 = 'concluida' THEN now() ELSE NULL END)
       ON CONFLICT (item_id, tipo) DO UPDATE
         SET status = EXCLUDED.status, nota = EXCLUDED.nota, updated_by = EXCLUDED.updated_by, updated_at = now(),
             concluida_em = CASE
               WHEN EXCLUDED.status = 'concluida' AND business_insights.status IS DISTINCT FROM 'concluida' THEN now()
               WHEN EXCLUDED.status = 'concluida' THEN business_insights.concluida_em
               ELSE NULL
             END
       RETURNING item_id, tipo, status, nota, updated_by, updated_at, concluida_em`,
      [String(item_id), String(tipo), status, nota != null ? String(nota).slice(0, 2000) : null, updatedBy]
    );
    res.json({ ok: true, status: rows[0] });
  } catch (e) {
    console.error('[bi] PATCH /margem/acoes-status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bi/margem/acoes-feedback — efeito OBSERVADO (nunca causal) das
// ações marcadas 'concluida'. Mesmo princípio do antes×depois de Recuperação
// (rankeamento.md): 14 dias fechados ANTES de concluida_em vs. desde
// concluida_em até hoje, expressos em taxa/dia (janelas de tamanho
// diferente, comparar total bruto seria enganoso). Reusa
// VENDA_DETALHE_SELECT/calcularMargemLinha — nunca uma 2ª fórmula de
// margem. 1 request em lote pra tela toda (não N por ação).
router.get('/margem/acoes-feedback', async (req, res) => {
  try {
    const { rows: concluidas } = await pool.query(
      `SELECT item_id, tipo, concluida_em FROM business_insights
       WHERE status = 'concluida' AND concluida_em IS NOT NULL`
    );
    if (!concluidas.length) return res.json({ feedback: [] });

    const itemIds = [...new Set(concluidas.map(c => c.item_id))];
    const minConcluidaEm = concluidas.reduce((min, c) => (c.concluida_em < min ? c.concluida_em : min), concluidas[0].concluida_em);

    const { rows } = await pool.query(
      `${VENDA_DETALHE_SELECT}
       WHERE o.item_id = ANY($1::text[])
         AND o.status <> 'cancelled'
         AND o.date_created >= $2::timestamptz - interval '14 days'
       ORDER BY o.date_created ASC`,
      [itemIds, minConcluidaEm]
    );
    const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
    const linhas = rows.map(r => calcularMargemLinha(r, impostoFlexAtivo, freteMotoboy));

    const agora = Date.now();
    const somar = (lista) => {
      const faturamento = lista.reduce((a, l) => a + (Number(l.faturamento) || 0), 0);
      const margem = lista.reduce((a, l) => a + (Number(l.margem) || 0), 0);
      return { pedidos: lista.length, faturamento, margem, mc_pct: faturamento > 0 ? Number(((margem / faturamento) * 100).toFixed(2)) : null };
    };
    const feedback = concluidas.map(c => {
      const concluidaEmMs = new Date(c.concluida_em).getTime();
      const antesInicioMs = concluidaEmMs - 14 * 86400000;
      const doItem = linhas.filter(l => l.item_id === c.item_id);
      const antes = doItem.filter(l => { const t = new Date(l.date_created).getTime(); return t >= antesInicioMs && t < concluidaEmMs; });
      const depois = doItem.filter(l => new Date(l.date_created).getTime() >= concluidaEmMs);
      const diasDepois = Math.max(1, (agora - concluidaEmMs) / 86400000);
      const antesAg = somar(antes), depoisAg = somar(depois);
      return {
        item_id: c.item_id, tipo: c.tipo, concluida_em: c.concluida_em,
        dias_desde_conclusao: Math.floor(diasDepois),
        antes: { ...antesAg, margem_dia: Number((antesAg.margem / 14).toFixed(2)), faturamento_dia: Number((antesAg.faturamento / 14).toFixed(2)) },
        depois: { ...depoisAg, margem_dia: Number((depoisAg.margem / diasDepois).toFixed(2)), faturamento_dia: Number((depoisAg.faturamento / diasDepois).toFixed(2)) },
      };
    });
    res.json({ feedback });
  } catch (e) {
    console.error('[bi] /margem/acoes-feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// TTL do cache da narrativa (abaixo) — 30min. A narrativa é sobre padrão do
// PERÍODO (causa raiz, resumo executivo), não sobre o segundo mais recente;
// 30min evita queimar tokens de novo a cada clique repetido no mesmo filtro,
// sem ficar tão velha que passe o dia inteiro sem refletir vendas novas.
// Mesmo padrão de "cache só por TTL, sem invalidação por evento" já usado em
// /vendas/detalhado e /vendas/margem (ver redis.md/decisions.md) — invalidar
// por order_updated seria frequente demais pro benefício.
const NARRATIVA_CACHE_TTL = 1800;

// POST /api/bi/margem/narrativa — Fase 2: camada de IA (LLM) que só
// INTERPRETA em português o JSON já calculado por computarMargem() acima.
// Síncrona, sob demanda (mesmo padrão de /analise/produtos/:id/analisar) —
// nunca roda sozinha, o analista clica um botão porque tem custo de token.
// A IA nunca recebe o portfólio inteiro (custo/tokens) — só um resumo com o
// que ela precisa pra escrever causa raiz + "o que eu faria agora".
// Cacheada por (days, store_id, category_id, date_from, date_to) — clicar de
// novo no mesmo filtro dentro do TTL devolve a mesma análise sem chamar o
// LLM de novo (ver NARRATIVA_CACHE_TTL acima).
router.post('/margem/narrativa', async (req, res) => {
  try {
    if (!llm.isConfigured()) {
      return res.status(503).json({ error: 'IA não configurada — cole a chave ANTHROPIC_API_KEY no .env do servidor e reinicie.' });
    }
    const params = parseMargemParams({ ...req.query, ...req.body });
    const cacheKey = `bi:margem:narrativa:${params.days}:${params.storeId}:${params.categoryId}:${params.dateFrom || ''}:${params.dateTo || ''}`;

    let cacheHit = true; // cached() só chama a função abaixo em caso de MISS
    const resultado = await cached(cacheKey, NARRATIVA_CACHE_TTL, async () => {
      cacheHit = false;
      const payload = await computarMargem(params);

      const resumirProduto = p => ({
        title: p.title, item_id: p.item_id, classificacao: p.classificacao,
        faturamento: Number(p.faturamento.toFixed(2)), margem: Number(p.margem.toFixed(2)),
        mc_pct: p.mc_pct, pedidos: p.pedidos, amostra_pequena: p.amostra_pequena,
        status_estoque: p.status_estoque, dias_estoque: p.dias_estoque, data_ruptura: p.data_ruptura,
      });
      const contexto = {
        periodo: payload.periodo,
        resumo: payload.resumo,
        saude: payload.saude,
        mudancas: payload.mudancas,
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
      return { narrativa, periodo: payload.periodo, gerado_em: new Date().toISOString() };
    });
    res.json({ ok: true, ...resultado, cache: cacheHit ? 'hit' : 'miss' });
  } catch (e) {
    if (e.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    console.error('[bi] /margem/narrativa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bi/margem/produto/:itemId — drill-down de UM anúncio (Fase B):
// série diária (não semanal — a Visão Geral já tem a semanal) de todas as
// métricas, pra alimentar o gráfico temporal e a decomposição em cascata do
// modal de detalhe em bi-margem-produtos.html. Consulta dedicada (não reusa
// computarMargem, que processa o portfólio inteiro) — pedir a série de 1
// SKU não deveria pagar o custo de agregar todos os outros.
router.get('/margem/produto/:itemId', async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const dias = Math.min(Math.max(Number(req.query.days) || 60, 7), 365);
    const storeId = String(req.query.store_id || '').trim();
    const params = [itemId, dias];
    let filtro = '';
    if (storeId) { params.push(storeId); filtro = `AND o.store_id = $${params.length}::bigint`; }
    const { rows } = await pool.query(
      `${VENDA_DETALHE_SELECT}
       WHERE o.item_id = $1
         AND o.status <> 'cancelled'
         AND o.date_created >= (CURRENT_DATE - $2::int + 1)
         ${filtro}
       ORDER BY o.date_created ASC
       LIMIT 5000`,
      params
    );
    if (!rows.length) return res.json({ item_id: itemId, dias, serie: [], resumo: null });
    const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
    const linhas = rows.map(r => calcularMargemLinha(r, impostoFlexAtivo, freteMotoboy));

    const porDia = new Map();
    for (const r of linhas) {
      const dia = String(r.date_created).slice(0, 10);
      let b = porDia.get(dia);
      if (!b) { b = { dia, faturamento: 0, margem: 0, custo: 0, imposto: 0, tarifa: 0, frete_vendedor: 0, qtd: 0, pedidos: 0, preco_soma: 0 }; porDia.set(dia, b); }
      b.faturamento += Number(r.faturamento) || 0;
      b.margem += r.margem;
      b.custo += r.custo; b.imposto += r.imposto; b.tarifa += r.tarifa; b.frete_vendedor += r.freteVend;
      b.qtd += Number(r.quantity) || 0;
      b.pedidos += 1;
      b.preco_soma += Number(r.unit_price) || 0;
    }
    const serie = [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map(b => ({
      dia: b.dia, faturamento: b.faturamento, margem: b.margem,
      mc_pct: b.faturamento > 0 ? Number(((b.margem / b.faturamento) * 100).toFixed(2)) : 0,
      preco_medio: b.pedidos > 0 ? b.preco_soma / b.pedidos : 0,
      frete_vendedor: b.frete_vendedor, tarifa: b.tarifa, custo: b.custo, qtd: b.qtd, pedidos: b.pedidos,
    }));

    const somar = (campo) => linhas.reduce((s, r) => s + (campo === 'faturamento' ? Number(r.faturamento) || 0 : r[campo]), 0);
    const fat = somar('faturamento'), margem = somar('margem');
    const ultima = linhas[linhas.length - 1];
    const resumo = {
      item_id: itemId, title: ultima.title, thumbnail: ultima.thumbnail,
      faturamento: fat, margem, mc_pct: fat > 0 ? (margem / fat) * 100 : 0,
      custo: somar('custo'), imposto: somar('imposto'), tarifa: somar('tarifa'), frete_vendedor: somar('freteVend'),
      qtd: linhas.reduce((s, r) => s + (Number(r.quantity) || 0), 0), pedidos: linhas.length,
      unit_price_atual: Number(ultima.unit_price) || 0,
      imposto_pct: Number(ultima.imposto_pct) || 0, // % fixo por loja — necessário pro simulador de preço recalcular imposto em cada cenário
    };
    res.json({ item_id: itemId, dias, serie, resumo });
  } catch (e) {
    console.error('[bi] /margem/produto/:itemId error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VENDAS POR ESTÁGIO — cruza o estágio de rankeamento (fonte: ranking_ads,
// nunca duplicado aqui — ver ranking.buscarFasePorItemIds) com as MESMAS
// vendas/margem de computarMargem() (mesma fórmula, finance.md).
//
// Histórico de estágio: `ranking_ads` só guarda o TIMESTAMP de entrada na
// fase atual (`started_at`/`ranqueado_em`/`monitoramento_started_at`/
// `recuperacao_started_at`) — voltar pra 'rankeando' LIMPA esses carimbos
// (rankeamento.md). Não dá pra reconstruir com confiança o estágio de um
// anúncio que já cicloud mais de uma vez. Por isso: toda venda (de hoje ou
// de 90 dias atrás) é rotulada com o ESTÁGIO ATUAL do anúncio, nunca uma
// reconstrução histórica — decisão consciente, ver decisions.md. Anúncio
// nunca marcado no módulo de Rankeamento cai no bucket `sem_rankeamento`
// (não é descartado — senão os totais da tela mentiriam).
// ═══════════════════════════════════════════════════════════════════════════

const FASES_RANKEAMENTO = ['rankeando', 'ranqueado', 'monitoramento', 'recuperacao'];

function novoBucketFase(fase) {
  return { fase, pedidos: 0, qtd: 0, faturamento: 0, margem: 0, custo: 0, imposto: 0, tarifa: 0, frete_vendedor: 0, frete_comprador: 0, visitas: 0 };
}
function agregarPorFase(linhas, visitasPorItem) {
  const buckets = new Map(FASES_RANKEAMENTO.map(f => [f, novoBucketFase(f)]));
  buckets.set('sem_rankeamento', novoBucketFase('sem_rankeamento'));
  const itensPorFase = new Map(); // fase -> Set(item_id), pra somar visitas sem contar 2x
  for (const r of linhas) {
    const fase = FASES_RANKEAMENTO.includes(r.fase) ? r.fase : 'sem_rankeamento';
    const b = buckets.get(fase);
    b.pedidos += 1; b.qtd += Number(r.quantity) || 0; b.faturamento += Number(r.faturamento) || 0;
    b.margem += r.margem; b.custo += r.custo; b.imposto += r.imposto; b.tarifa += r.tarifa;
    b.frete_vendedor += r.freteVend; b.frete_comprador += Number(r.frete_comprador) || 0;
    if (r.item_id) { let s = itensPorFase.get(fase); if (!s) { s = new Set(); itensPorFase.set(fase, s); } s.add(r.item_id); }
  }
  const totalFat = linhas.reduce((s, r) => s + (Number(r.faturamento) || 0), 0);
  const totalPedidos = linhas.length;
  if (visitasPorItem) {
    for (const [fase, itens] of itensPorFase) {
      const b = buckets.get(fase);
      for (const item of itens) b.visitas += visitasPorItem.get(item) || 0;
    }
  }
  return [...buckets.values()].map(b => ({
    ...b,
    ticket: b.pedidos > 0 ? b.faturamento / b.pedidos : 0,
    mc_pct: b.faturamento > 0 ? (b.margem / b.faturamento) * 100 : 0,
    participacao_faturamento_pct: totalFat > 0 ? (b.faturamento / totalFat) * 100 : 0,
    participacao_pedidos_pct: totalPedidos > 0 ? (b.pedidos / totalPedidos) * 100 : 0,
    conversao_pct: b.visitas > 0 ? (b.pedidos / b.visitas) * 100 : null, // null = "dados insuficientes", nunca 0 forçado
  }));
}
// Comparação hoje vs. um período de referência (ontem = valor cru; média 7d
// = soma÷7) — mesmos 4+1 buckets nas duas listas, na mesma ordem.
function compararFases(atualBuckets, refBuckets, divisorRef) {
  const porFase = new Map(refBuckets.map(b => [b.fase, b]));
  return atualBuckets.map(a => {
    const ref = porFase.get(a.fase) || novoBucketFase(a.fase);
    const refPedidos = (ref.pedidos || 0) / divisorRef, refFat = (ref.faturamento || 0) / divisorRef, refMargem = (ref.margem || 0) / divisorRef;
    const variacao = (atual, refv) => refv > 0 ? ((atual - refv) / refv) * 100 : (atual > 0 ? 100 : 0);
    return {
      fase: a.fase,
      atual: { pedidos: a.pedidos, faturamento: a.faturamento, margem: a.margem },
      referencia: { pedidos: refPedidos, faturamento: refFat, margem: refMargem },
      variacao_pedidos_pct: variacao(a.pedidos, refPedidos),
      variacao_faturamento_pct: variacao(a.faturamento, refFat),
      variacao_margem_pct: variacao(a.margem, refMargem),
    };
  });
}

// Score 0-100 por estágio (só os 4 reais — `sem_rankeamento` não é um
// estágio de processo, fica de fora do ranking de score). Reusa as MESMAS
// funções de sub-score da Saúde do Negócio (escalaLinear/scoreRentabilidade/
// scoreCrescimento/percentil já definidas acima) — nunca uma 2ª fórmula.
function scoreEstagios(buckets, comparacao7d, diasNoPeriodoSerie) {
  const reais = buckets.filter(b => FASES_RANKEAMENTO.includes(b.fase));
  const pedidosLista = reais.map(b => b.pedidos);
  const compPorFase = new Map(comparacao7d.map(c => [c.fase, c]));
  return reais.map(b => {
    const comp = compPorFase.get(b.fase);
    const diasComVenda = diasNoPeriodoSerie ? (diasNoPeriodoSerie.get(b.fase) || 0) : 0;
    const totalDias = diasNoPeriodoSerie ? diasNoPeriodoSerie.get('__total_dias__') || 1 : 1;
    const scoreVolume = percentil(pedidosLista, b.pedidos) * 100;
    const scoreMc = scoreRentabilidade(b.mc_pct);
    const scoreCresc = comp ? scoreCrescimento(comp.variacao_faturamento_pct) : 50;
    const scoreEstab = totalDias > 0 ? Math.min(100, (diasComVenda / totalDias) * 100) : 0;
    const score = Math.round((scoreVolume + scoreMc + scoreCresc + scoreEstab) / 4);
    return { fase: b.fase, score, subscores: { volume: Math.round(scoreVolume), rentabilidade: Math.round(scoreMc), crescimento: Math.round(scoreCresc), estabilidade: Math.round(scoreEstab) } };
  }).sort((a, b) => b.score - a.score);
}

// Insights automáticos (texto templated determinístico — nunca LLM aqui,
// mesmo princípio de "não inventar" das ações recomendadas de margem).
function insightsEstagios(buckets, comparacaoOntem, comparacao7d) {
  const insights = [];
  const reais = buckets.filter(b => FASES_RANKEAMENTO.includes(b.fase) && b.pedidos > 0);
  if (!reais.length) return insights;
  const totalPedidos = reais.reduce((s, b) => s + b.pedidos, 0);
  const lider = [...reais].sort((a, b) => b.pedidos - a.pedidos)[0];
  if (lider && totalPedidos > 0) insights.push(`${FASE_LABEL_PT[lider.fase]} representa ${(lider.pedidos / totalPedidos * 100).toFixed(0)}% dos pedidos do período.`);
  const porCresc = [...comparacao7d].filter(c => FASES_RANKEAMENTO.includes(c.fase)).sort((a, b) => b.variacao_faturamento_pct - a.variacao_faturamento_pct);
  if (porCresc.length) {
    const maiorAlta = porCresc[0], maiorQueda = porCresc[porCresc.length - 1];
    if (maiorAlta.variacao_faturamento_pct > 10) insights.push(`${FASE_LABEL_PT[maiorAlta.fase]} cresceu ${maiorAlta.variacao_faturamento_pct.toFixed(0)}% em faturamento vs. a média dos últimos 7 dias.`);
    if (maiorQueda.variacao_faturamento_pct < -10) insights.push(`${FASE_LABEL_PT[maiorQueda.fase]} caiu ${Math.abs(maiorQueda.variacao_faturamento_pct).toFixed(0)}% em faturamento vs. a média dos últimos 7 dias.`);
  }
  const mcOrdenado = [...reais].sort((a, b) => b.mc_pct - a.mc_pct);
  const mcMedia = reais.reduce((s, b) => s + b.mc_pct, 0) / reais.length;
  if (mcOrdenado.length && mcOrdenado[0].mc_pct > mcMedia + 5) insights.push(`${FASE_LABEL_PT[mcOrdenado[0].fase]} tem MC média de ${mcOrdenado[0].mc_pct.toFixed(1)}%, acima da média geral de ${mcMedia.toFixed(1)}%.`);
  return insights;
}
const FASE_LABEL_PT = { rankeando: 'Em rankeamento', ranqueado: 'Ranqueado', monitoramento: 'Monitoramento', recuperacao: 'Recuperação', sem_rankeamento: 'Sem rankeamento' };

// Período: ou `days` (padrão, N dias terminando hoje) ou `dateFrom`/`dateTo`
// explícitos (Hoje/período personalizado, resolvidos no frontend — mesmo
// contrato de computarMargem/Fase A, business-rules.md). "Hoje" sozinho já
// funciona com days=1 (periodoIni = hoje - 0 = hoje), sem precisar de
// dateFrom/dateTo — só o período PERSONALIZADO precisa deles.
async function computarRankeamento({ days, storeId, dateFrom, dateTo } = {}) {
  const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
  const buscarPeriodo = async (dIni, dFim, marcador) => {
    const p = [dIni, dFim];
    let filtro = '';
    if (storeId) { p.push(storeId); filtro = `AND o.store_id = $${p.length}::bigint`; }
    const { rows } = await pool.query(
      `-- rankeamento-${marcador}
       ${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled' AND o.date_created >= $1::date AND o.date_created < ($2::date + 1) ${filtro}
       ORDER BY o.date_created DESC LIMIT 20000`,
      p
    );
    return rows.map(r => calcularMargemLinha(r, impostoFlexAtivo, freteMotoboy));
  };

  const hojeISO = addDiasISO(0);
  const ontemISO = addDiasStr(hojeISO, -1);
  // "hoje"/"ontem"/"7 dias" ficam SEMPRE ancorados no hoje real, independente
  // do período personalizado escolhido — são comparações de "como está indo
  // agora", não do fim do intervalo navegado (mesmo princípio de
  // computarMargem: período anterior sempre relativo, essas 3 janelas aqui
  // são absolutas de propósito).
  let periodoIni, periodoFim, duracaoDias;
  if (dateFrom && dateTo) {
    periodoIni = dateFrom; periodoFim = dateTo;
    duracaoDias = Math.round((new Date(periodoFim + 'T00:00:00Z') - new Date(periodoIni + 'T00:00:00Z')) / 86400000) + 1;
  } else {
    periodoFim = hojeISO;
    periodoIni = addDiasStr(hojeISO, -(days - 1));
    duracaoDias = days;
  }
  const sete_dIni = addDiasStr(hojeISO, -7), sete_dFim = ontemISO; // últimos 7 dias FECHADOS (exclui hoje, que é parcial)

  const [linhasPeriodo, linhasHoje, linhasOntem, linhas7d] = await Promise.all([
    buscarPeriodo(periodoIni, periodoFim, 'periodo'),
    buscarPeriodo(hojeISO, hojeISO, 'hoje'),
    buscarPeriodo(ontemISO, ontemISO, 'ontem'),
    buscarPeriodo(sete_dIni, sete_dFim, '7d'),
  ]);

  // Estágio atual de cada item_id envolvido (união de todos os conjuntos —
  // o período principal pode não cobrir a janela de 7 dias se `days` < 7).
  const todosItemIds = new Set();
  [linhasPeriodo, linhasHoje, linhasOntem, linhas7d].forEach(ls => ls.forEach(r => { if (r.item_id) todosItemIds.add(r.item_id); }));
  const faseMap = await ranking.buscarFasePorItemIds([...todosItemIds]);
  const anotar = (linhas) => linhas.forEach(r => { r.fase = faseMap.get(r.item_id)?.fase || null; });
  [linhasPeriodo, linhasHoje, linhasOntem, linhas7d].forEach(anotar);

  // Visitas do período (item_visits, dado real — soma bruta, não estimada).
  const visitasParams = [periodoIni, hojeISO];
  let visitasFiltro = '';
  if (storeId) { visitasParams.push(storeId); visitasFiltro = `AND store_id = $${visitasParams.length}::bigint`; }
  const { rows: visitasRows } = await pool.query(
    `SELECT item_id, COALESCE(SUM(visits),0)::int AS visitas FROM item_visits WHERE date >= $1::date AND date <= $2::date ${visitasFiltro} GROUP BY item_id`,
    visitasParams
  );
  const visitasPorItem = new Map(visitasRows.map(r => [r.item_id, r.visitas]));

  const porFasePeriodo = agregarPorFase(linhasPeriodo, visitasPorItem);
  const porFaseHoje = agregarPorFase(linhasHoje, null);
  const porFaseOntem = agregarPorFase(linhasOntem, null);
  const porFase7dBruto = agregarPorFase(linhas7d, null);
  const comparacaoOntem = compararFases(porFaseHoje, porFaseOntem, 1);
  const comparacao7d = compararFases(porFaseHoje, porFase7dBruto, 7);

  // Série diária por estágio (§12) — reaproveita linhasPeriodo, sem query nova.
  const porDiaFase = new Map();
  const diasComVendaPorFase = new Map(); // pra estabilidade do score
  for (const r of linhasPeriodo) {
    const dia = String(r.date_created).slice(0, 10);
    const fase = FASES_RANKEAMENTO.includes(r.fase) ? r.fase : 'sem_rankeamento';
    let porFase = porDiaFase.get(dia); if (!porFase) { porFase = {}; porDiaFase.set(dia, porFase); }
    if (!porFase[fase]) porFase[fase] = { pedidos: 0, faturamento: 0, margem: 0, qtd: 0 };
    porFase[fase].pedidos += 1; porFase[fase].faturamento += Number(r.faturamento) || 0; porFase[fase].margem += r.margem; porFase[fase].qtd += Number(r.quantity) || 0;
    let diasSet = diasComVendaPorFase.get(fase); if (!diasSet) { diasSet = new Set(); diasComVendaPorFase.set(fase, diasSet); }
    diasSet.add(dia);
  }
  const serieDiaria = [...porDiaFase.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dia, fases]) => ({ dia, fases }));
  const diasNoPeriodoMap = new Map([...diasComVendaPorFase.entries()].map(([f, s]) => [f, s.size]));
  diasNoPeriodoMap.set('__total_dias__', duracaoDias);

  // Por anúncio dentro do estágio (§16) — agregação por item_id, já com fase.
  const bySku = new Map();
  for (const r of linhasPeriodo) {
    const k = r.item_id || `sem-anuncio-${r.ml_id}`;
    let s = bySku.get(k);
    if (!s) { s = { item_id: r.item_id, title: r.title, thumbnail: r.thumbnail, fase: FASES_RANKEAMENTO.includes(r.fase) ? r.fase : 'sem_rankeamento', estoque_atual: r.estoque_atual, faturamento: 0, margem: 0, pedidos: 0, qtd: 0 }; bySku.set(k, s); }
    s.faturamento += Number(r.faturamento) || 0; s.margem += r.margem; s.pedidos += 1; s.qtd += Number(r.quantity) || 0;
  }
  const produtosPorEstagio = [...bySku.values()].map(s => ({ ...s, mc_pct: s.faturamento > 0 ? Number(((s.margem / s.faturamento) * 100).toFixed(2)) : 0, visitas: visitasPorItem.get(s.item_id) || 0 }));
  // Fora do padrão (§17): pedidos MUITO abaixo/acima da média do próprio estágio.
  FASES_RANKEAMENTO.forEach(fase => {
    const doEstagio = produtosPorEstagio.filter(p => p.fase === fase);
    if (doEstagio.length < 3) return; // amostra pequena demais pra comparar com a média
    const mediaPedidos = doEstagio.reduce((s, p) => s + p.pedidos, 0) / doEstagio.length;
    doEstagio.forEach(p => {
      if (mediaPedidos > 0 && p.pedidos <= mediaPedidos * 0.4) p.fora_do_padrao = 'abaixo';
      else if (mediaPedidos > 0 && p.pedidos >= mediaPedidos * 2) p.fora_do_padrao = 'acima';
    });
  });

  // Recuperação: antes × depois (§15) — só anúncios ATUALMENTE em recuperação,
  // usando o ÚNICO carimbo confiável (recuperacao_started_at). "Antes" = 14
  // dias fechados antes de entrar; "depois" = desde que entrou. Efeito
  // OBSERVADO, nunca causal (linguagem obrigatória — ver business-rules.md).
  const recParams = storeId ? [storeId] : [];
  const recFiltro = storeId ? `AND r.store_id = $1::bigint` : '';
  const { rows: recRows } = await pool.query(
    `SELECT r.id, r.ml_id, r.title, r.recuperacao_started_at,
            COUNT(*) FILTER (WHERE e.event_type='venda' AND e.created_at < r.recuperacao_started_at AND e.created_at >= r.recuperacao_started_at - interval '14 days') AS vendas_antes,
            COUNT(*) FILTER (WHERE e.event_type='venda' AND e.created_at >= r.recuperacao_started_at) AS vendas_depois
       FROM ranking_ads r
       LEFT JOIN ranking_events e ON e.ranking_ad_id = r.id
      WHERE r.fase = 'recuperacao' AND r.active = true AND r.recuperacao_started_at IS NOT NULL ${recFiltro}
      GROUP BY r.id`,
    recParams
  );
  const agora = Date.now();
  const recuperacaoAntesDepois = recRows.map(r => {
    const diasDepois = Math.max(1, (agora - new Date(r.recuperacao_started_at).getTime()) / 86400000);
    return {
      item_id: r.ml_id, title: r.title,
      vendas_dia_antes: Number(r.vendas_antes) / 14,
      vendas_dia_depois: Number(r.vendas_depois) / diasDepois,
      dias_em_recuperacao: Math.floor(diasDepois),
    };
  });

  const totalPedidosHoje = linhasHoje.length;
  const resumoHoje = {
    total_pedidos: totalPedidosHoje,
    total_faturamento: linhasHoje.reduce((s, r) => s + (Number(r.faturamento) || 0), 0),
    por_fase: porFaseHoje.map(b => ({ fase: b.fase, pedidos: b.pedidos, faturamento: b.faturamento })),
  };
  const vendasHojeLista = [...linhasHoje].sort((a, b) => new Date(b.date_created) - new Date(a.date_created)).slice(0, 200).map(r => ({
    hora: r.date_created, title: r.title, sku: r.sku, item_id: r.item_id, conta: r.conta,
    faturamento: Number(r.faturamento) || 0, fase: r.fase || 'sem_rankeamento',
    frete_vendedor: r.freteVend, tarifa: r.tarifa, custo: r.custo, imposto: r.imposto, margem: r.margem, mc_pct: r.mc_pct,
  }));

  const score = scoreEstagios(porFasePeriodo, comparacao7d, diasNoPeriodoMap);
  const insights = insightsEstagios(porFasePeriodo, comparacaoOntem, comparacao7d);
  const liderHoje = [...porFaseHoje].filter(b => FASES_RANKEAMENTO.includes(b.fase)).sort((a, b) => b.pedidos - a.pedidos)[0] || null;

  return {
    periodo: { dias: duracaoDias, de: periodoIni, ate: periodoFim },
    visao_executiva: {
      estagio_lider_hoje: liderHoje ? { fase: liderHoje.fase, pedidos: liderHoje.pedidos, faturamento: liderHoje.faturamento, margem: liderHoje.margem } : null,
      score,
    },
    por_fase_periodo: porFasePeriodo,
    resumo_hoje: resumoHoje,
    vendas_hoje: vendasHojeLista,
    comparacao_ontem: comparacaoOntem,
    comparacao_7d: comparacao7d,
    serie_diaria: serieDiaria,
    produtos_por_estagio: produtosPorEstagio,
    recuperacao_antes_depois: recuperacaoAntesDepois,
    insights,
  };
}

router.get('/rankeamento', async (req, res) => {
  try {
    const q = req.query;
    const temIntervalo = q.date_from && q.date_to;
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
    const storeId = String(q.store_id || '').trim();
    res.json(await computarRankeamento({
      days, storeId,
      dateFrom: temIntervalo ? q.date_from : null,
      dateTo: temIntervalo ? q.date_to : null,
    }));
  } catch (e) {
    console.error('[bi] /rankeamento error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
// computarMargem também é usado fora deste arquivo (Agente Financeiro,
// routes/agenteFinanceiro.js) pra cruzar a margem real do ML com o Financeiro
// — nunca uma 2ª fórmula de margem. `router` é uma função (Express Router),
// então pendurar a propriedade nela não quebra `app.use('/api/bi', require('./routes/bi'))`.
module.exports.computarMargem = computarMargem;
