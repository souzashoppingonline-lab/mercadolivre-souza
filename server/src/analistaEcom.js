// Analista Ecom — Central de Análise e Precificação dos anúncios (módulo
// Inteligência de Negócio). Responde "por quanto devo vender pra bater a
// margem alvo" — diferente de Inteligência de Margem (`vendaMargem.js` +
// `routes/bi.js` computarMargem), que analisa a margem REAL das vendas já
// feitas via Conciliação Bancária. Aqui é PRESCRITIVO: cobre todos os
// anúncios ativos (vendeu ou não), usando suposições CONFIGURADAS (tarifa
// por categoria, frete padrão, imposto, margem alvo/mínima) — nunca a taxa
// real por pedido, porque a maioria dos anúncios não tem pedido nenhum no
// período. Nunca inventa número: sem custo/tarifa cadastrados, os campos de
// preço ficam `null` e o diagnóstico avisa, em vez de assumir um valor.
//
// Reusa (nunca duplica): items.cost/cost_updated_at (custo por anúncio,
// v89), item_seo_score (visitas/conversão/vendas 30d — já sincronizado 1x/
// dia pelo job sync-seo-score, zero chamada nova ao ML), seoScore.THRESHOLDS
// (mesmo corte de "conversão boa" usado na nota do SEO Score),
// ranking.buscarFasePorItemIds (estágio do Rankeamento, mesma função usada
// por Inteligência de Margem/Vendas por Estágio). Ver .claude/decisions.md.
const pool = require('./db/pool');
const ranking = require('./ranking');
const { THRESHOLDS: SEO_THRESHOLDS } = require('./seoScore');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Configuração global (frete/imposto/margem) — app_config key/value já
// existente, mesmo padrão de imposto_flex_ativo/frete_motoboy_valor. Não
// precisa de migration pra chave nova. ────────────────────────────────────
// Imposto NÃO entra aqui — é por LOJA (pedido explícito do usuário) e já
// existe: `stores.imposto_pct`, editável em pages/lojas.html
// (`PATCH /api/lojas/:id`). Reusado direto na query, nunca um 2º cadastro
// de imposto pra não divergir do que o resto do sistema já usa (mesma
// coluna que `vendaMargem.js`/Vendas por Loja leem).
const CONFIG_KEYS = {
  frete_padrao: 'analista_ecom_frete_padrao',
  margem_alvo_pct: 'analista_ecom_margem_alvo',
  margem_minima_pct: 'analista_ecom_margem_minima',
};
const CONFIG_DEFAULTS = { frete_padrao: 0, margem_alvo_pct: 20, margem_minima_pct: 10 };

async function getConfigGlobal() {
  const { rows } = await pool.query(`SELECT key, value FROM app_config WHERE key = ANY($1)`, [Object.values(CONFIG_KEYS)]);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const [campo, key] of Object.entries(CONFIG_KEYS)) out[campo] = map[key] != null ? Number(map[key]) : CONFIG_DEFAULTS[campo];
  return out;
}
async function setConfigGlobal(campo, valor) {
  const key = CONFIG_KEYS[campo];
  if (!key) { const e = new Error(`config inválida: ${campo}`); e.status = 400; throw e; }
  const n = Number(valor);
  if (!isFinite(n) || n < 0) { const e = new Error(`${campo} deve ser um número >= 0`); e.status = 400; throw e; }
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
    [key, String(n)]
  );
  return n;
}

// ── Tarifa por categoria (pricing_category_fees, v90) — política do ML, é
// por CATEGORIA, não por loja (a mesma categoria cobra a mesma comissão
// independente de qual das suas contas está anunciando). ──────────────────
async function getTarifasCategorias() {
  const { rows } = await pool.query(`SELECT category_id, category_name, fee_percentage FROM pricing_category_fees ORDER BY category_name NULLS LAST, category_id`);
  return rows.map((r) => ({ ...r, fee_percentage: Number(r.fee_percentage) }));
}
async function setTarifaCategoria(category_id, category_name, fee_percentage) {
  if (!category_id) { const e = new Error('category_id obrigatório'); e.status = 400; throw e; }
  const n = Number(fee_percentage);
  if (!isFinite(n) || n < 0 || n > 100) { const e = new Error('fee_percentage deve ser um número entre 0 e 100'); e.status = 400; throw e; }
  await pool.query(
    `INSERT INTO pricing_category_fees (category_id, category_name, fee_percentage, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (category_id) DO UPDATE SET category_name=EXCLUDED.category_name, fee_percentage=EXCLUDED.fee_percentage, updated_at=now()`,
    [category_id, category_name || null, n]
  );
}
async function deleteTarifaCategoria(category_id) {
  await pool.query(`DELETE FROM pricing_category_fees WHERE category_id=$1`, [category_id]);
}

// ── Margem alvo POR ANÚNCIO (v91) — items.margem_alvo_pct, NULL = usa a
// margem alvo global (CONFIG_DEFAULTS.margem_alvo_pct/app_config acima).
// Pedido do usuário: cada anúncio pode ter sua própria meta, sem precisar
// mudar a config global (que afetaria todo o portfólio de uma vez). ──────
async function setMargemAlvoItem(mlId, valor) {
  if (!mlId) { const e = new Error('mlId obrigatório'); e.status = 400; throw e; }
  if (valor === null || valor === '') {
    await pool.query(`UPDATE items SET margem_alvo_pct = NULL WHERE ml_id = $1`, [mlId]);
    return null;
  }
  const n = Number(valor);
  if (!isFinite(n) || n < 0 || n >= 100) { const e = new Error('margem alvo deve ser um número entre 0 e 99'); e.status = 400; throw e; }
  await pool.query(`UPDATE items SET margem_alvo_pct = $2 WHERE ml_id = $1`, [mlId, n]);
  return n;
}

// ── Frete POR ANÚNCIO (v93) — items.frete, NULL = usa o frete padrão
// global (CONFIG_DEFAULTS.frete_padrao/app_config). Pedido do usuário:
// definir o frete de um anúncio deve mudar SÓ aquele anúncio, não o padrão
// de todos — mesmo padrão de margem_alvo_pct acima (v91). ─────────────────
async function setFreteItem(mlId, valor) {
  if (!mlId) { const e = new Error('mlId obrigatório'); e.status = 400; throw e; }
  if (valor === null || valor === '') {
    await pool.query(`UPDATE items SET frete = NULL WHERE ml_id = $1`, [mlId]);
    return null;
  }
  const n = Number(valor);
  if (!isFinite(n) || n < 0) { const e = new Error('frete deve ser um número >= 0'); e.status = 400; throw e; }
  await pool.query(`UPDATE items SET frete = $2 WHERE ml_id = $1`, [mlId, n]);
  return n;
}

// ── Fórmula de precificação (P = (C+F) / (1-T-I-M)) ─────────────────────
// Divisor <= 0 significa que NENHUM preço finito atinge essa margem com
// essas taxas (ex.: tarifa+imposto+margem somam >= 100%) — retorna null,
// nunca um número aproximado/negativo sem sentido.
function precoParaMargem({ custo, frete, tarifaPct, impostoPct, margemPct }) {
  const divisor = 1 - (Number(tarifaPct) / 100) - (Number(impostoPct) / 100) - (Number(margemPct) / 100);
  if (!(divisor > 0)) return null;
  return round2((Number(custo) + Number(frete)) / divisor);
}
// Margem (R$ e %) resultante de vender a um preço P — inverso da fórmula
// acima; usado pra "margem atual" e pelo simulador de preço.
function margemNoPreco({ preco, custo, frete, tarifaPct, impostoPct }) {
  const p = Number(preco);
  if (!(p > 0)) return { reais: null, pct: null };
  const reais = round2(p * (1 - Number(tarifaPct) / 100 - Number(impostoPct) / 100) - Number(frete) - Number(custo));
  return { reais, pct: round2((reais / p) * 100) };
}

// ── Diagnóstico automático (seção 12/25 do pedido) ──────────────────────
// Thresholds de conversão REUSAM os já vetados em seoScore.js (mesmo campo,
// item_seo_score.conversion_rate/visits_30d) — nunca um 2º critério
// desalinhado pro mesmo dado. VISITAS_30D_RELEVANTES é o único threshold
// genuinamente novo desta tarefa (sem precedente na escala de 30 dias no
// projeto) — documentado aqui, ajustável se a operação mostrar que não
// bate com a realidade.
const CONVERSAO_BOA = SEO_THRESHOLDS.conversionForFullScore;   // 5% — mesmo corte de nota máxima do SEO Score
const CONVERSAO_RUIM = 0.01;                                    // 1% — mesmo corte de "conversão baixa" do diagnóstico de Recuperação (routes/ranking.js CONV_BAIXA)
const VISITAS_30D_RELEVANTES = 100;                             // novo — ~3,3 visitas/dia, tráfego que já justifica avaliar conversão
const TOLERANCIA_MARGEM_PP = 2;                                 // margem a até 2pp da meta = "próxima o suficiente" pra manter

function diagnosticar({ fase, custoAusente, tarifaAusente, margemAtualPct, margemAlvoPct, conversionRate, visits30d, sales30d }) {
  if (fase === 'catalogo') return { tipo: 'NAO_ALTERAR_CATALOGO', label: 'Não alterar — Catálogo/Buy Box', texto: 'Preço em disputa de catálogo segue a regra do estágio Catálogo do Rankeamento — mudar aqui sem olhar lá pode tirar o anúncio da disputa.' };
  if (custoAusente) return { tipo: 'CUSTO_NAO_CADASTRADO', label: 'Custo não cadastrado', texto: 'Cadastre o custo do produto para calcular preço e margem com confiança.' };
  if (tarifaAusente) return { tipo: 'TARIFA_NAO_CONFIGURADA', label: 'Tarifa não configurada', texto: 'Cadastre a tarifa da categoria deste anúncio na configuração.' };
  if (margemAtualPct == null) return { tipo: 'SEM_DADOS', label: 'Sem dados suficientes', texto: 'Sem preço atual válido para calcular a margem.' };

  const trafegoRelevante = (visits30d || 0) >= VISITAS_30D_RELEVANTES;
  const conversaoBoa = conversionRate != null && conversionRate >= CONVERSAO_BOA;
  const conversaoRuim = conversionRate == null || conversionRate < CONVERSAO_RUIM;
  const vendasBaixas = (sales30d || 0) <= 1;

  // "Preço pode não ser o único problema" (seção 25) — tráfego chegando e
  // não convertendo pesa mais que a margem estar ok ou não.
  if (trafegoRelevante && conversaoRuim && vendasBaixas) {
    return { tipo: 'REVISAR_ANUNCIO', label: 'Revisar anúncio', texto: `${visits30d} visita(s) em 30d, conversão ${conversionRate == null ? 'sem histórico' : (conversionRate * 100).toFixed(1) + '%'} — o problema pode não ser só o preço (fotos, título, atributos, reputação).` };
  }
  const diffPp = margemAtualPct - margemAlvoPct;
  if (diffPp < -TOLERANCIA_MARGEM_PP && trafegoRelevante && conversaoBoa) {
    return { tipo: 'AUMENTAR_PRECO', label: 'Aumentar preço', texto: `Margem ${margemAtualPct.toFixed(1)}% está ${Math.abs(diffPp).toFixed(1)}pp abaixo da meta, e o anúncio converte bem (${(conversionRate * 100).toFixed(1)}%) — tráfego sustenta um preço maior.` };
  }
  if (diffPp > TOLERANCIA_MARGEM_PP * 2 && trafegoRelevante && conversaoRuim) {
    return { tipo: 'REDUZIR_PRECO', label: 'Reduzir preço', texto: `Margem ${margemAtualPct.toFixed(1)}% está bem acima da meta, mas a conversão está baixa — o preço pode estar afastando comprador.` };
  }
  if (Math.abs(diffPp) <= TOLERANCIA_MARGEM_PP) {
    return { tipo: 'MANTER_PRECO', label: 'Manter preço', texto: `Margem ${margemAtualPct.toFixed(1)}% está próxima da meta (${margemAlvoPct}%).` };
  }
  return { tipo: 'MANTER_PRECO', label: 'Manter preço', texto: 'Sem sinal forte o bastante pra recomendar mudança agora — acompanhe.' };
}

// ── Linha completa (1 anúncio) — cálculo puro, sem I/O ──────────────────
function calcularLinha(row, cfg, fase) {
  const custoAusente = row.cost_updated_at == null;
  const custo = Number(row.cost) || 0;
  const tarifaPct = row.tarifa_pct != null ? Number(row.tarifa_pct) : null;
  const tarifaAusente = tarifaPct == null;
  // Frete — override por ANÚNCIO (items.frete, v93) quando cadastrado,
  // senão cai no frete padrão global (mesmo comportamento de antes).
  const fretePersonalizado = row.frete_override != null;
  const frete = fretePersonalizado ? Number(row.frete_override) : cfg.frete_padrao;
  const impostoPct = Number(row.imposto_pct) || 0; // stores.imposto_pct — por loja, nunca configurado aqui
  const precoAtual = Number(row.price) || 0;
  // Margem alvo — override por ANÚNCIO (items.margem_alvo_pct, v91) quando
  // cadastrado, senão cai na meta global (mesmo comportamento de antes).
  const margemAlvoPersonalizada = row.margem_alvo_pct_override != null;
  const margemAlvoPct = margemAlvoPersonalizada ? Number(row.margem_alvo_pct_override) : cfg.margem_alvo_pct;

  const podecalcular = !custoAusente && !tarifaAusente;
  const margemAtual = podecalcular ? margemNoPreco({ preco: precoAtual, custo, frete, tarifaPct, impostoPct }) : { reais: null, pct: null };
  const precoEquilibrio = podecalcular ? precoParaMargem({ custo, frete, tarifaPct, impostoPct, margemPct: 0 }) : null;
  const precoMinimo = podecalcular ? precoParaMargem({ custo, frete, tarifaPct, impostoPct, margemPct: cfg.margem_minima_pct }) : null;
  const precoRecomendado = podecalcular ? precoParaMargem({ custo, frete, tarifaPct, impostoPct, margemPct: margemAlvoPct }) : null;
  const diferencaRecomendadoPct = (precoRecomendado != null && precoAtual > 0) ? round2(((precoRecomendado - precoAtual) / precoAtual) * 100) : null;

  const diag = diagnosticar({
    fase, custoAusente, tarifaAusente,
    margemAtualPct: margemAtual.pct, margemAlvoPct,
    conversionRate: row.conversion_rate != null ? Number(row.conversion_rate) : null,
    visits30d: row.visits_30d != null ? Number(row.visits_30d) : null,
    sales30d: row.sales_30d != null ? Number(row.sales_30d) : null,
  });

  // Oportunidade de margem (seção 15) — ganho POTENCIAL estimado se o preço
  // subisse pro recomendado, sem tocar em volume/conversão (é uma
  // suposição explícita, nunca "lucro garantido" — rótulo no frontend deixa
  // isso claro). Só existe quando a ação é literalmente aumentar preço.
  const oportunidadeReais = (diag.tipo === 'AUMENTAR_PRECO' && precoRecomendado != null && margemAtual.reais != null)
    ? round2(margemNoPreco({ preco: precoRecomendado, custo, frete, tarifaPct, impostoPct }).reais - margemAtual.reais)
    : 0;

  return {
    // SKU = o próprio MLB do anúncio (pedido explícito do usuário) — não há
    // coluna sku própria em `items` neste projeto (só existe dentro do
    // raw_data de PEDIDOS, então anúncio que nunca vendeu não teria SKU
    // nenhum); usar o ml_id evita esse buraco e mantém 1 identidade só por
    // anúncio, mesmo padrão que sku_costs já usa (ver finance.md/known-bugs.md).
    ml_id: row.ml_id, store_id: row.store_id, loja: row.loja, title: row.title, thumbnail: row.thumbnail,
    sku: row.ml_id, category_id: row.category_id, category_name: row.category_name || null,
    status: row.status, available_quantity: row.available_quantity,
    // Promoção — reusa a MESMA tabela/regra já usada por handleOffer/tg_promocoes
    // (promotions.status='active' é o valor já confirmado/usado em produção pra
    // "está em promoção agora", ver business-rules.md "Promoções — transições
    // de status notificadas"). Não é um cadastro novo, só exibição do que já existe.
    em_promocao: row.promo_status === 'active',
    promo_price: row.promo_price != null ? Number(row.promo_price) : null,
    promo_discount_pct: row.promo_discount_pct != null ? Number(row.promo_discount_pct) : null,
    price: precoAtual, custo, custo_ausente: custoAusente,
    tarifa_pct: tarifaPct, tarifa_ausente: tarifaAusente,
    frete, frete_personalizado: fretePersonalizado, imposto_pct: impostoPct,
    visits_30d: row.visits_30d != null ? Number(row.visits_30d) : null,
    sales_30d: row.sales_30d != null ? Number(row.sales_30d) : null,
    conversion_rate: row.conversion_rate != null ? Number(row.conversion_rate) : null,
    qualidade: row.qualidade != null ? Number(row.qualidade) : null,
    fase: fase || null,
    margem_atual_reais: margemAtual.reais, margem_atual_pct: margemAtual.pct,
    margem_alvo_pct: margemAlvoPct, margem_alvo_personalizada: margemAlvoPersonalizada, margem_minima_pct: cfg.margem_minima_pct,
    preco_equilibrio: precoEquilibrio, preco_minimo: precoMinimo, preco_recomendado: precoRecomendado,
    diferenca_recomendado_pct: diferencaRecomendadoPct,
    diagnostico: diag,
    oportunidade_reais: oportunidadeReais,
  };
}

// ── Listagem completa ────────────────────────────────────────────────────
// 1 query com todos os JOINs (item_seo_score/pricing_category_fees/nome real
// da categoria/SKU do último pedido) + 1 batch pra fase
// (ranking.buscarFasePorItemIds) — nunca 1 chamada por card. Filtro/
// ordenação/paginação em JS (depois de calcular os campos derivados, que
// não existem como coluna) — catálogo de umas poucas lojas cabe tranquilo em
// memória numa única resposta.
//
// SÓ Mercado Livre — lê de vw_ml_items/vw_ml_stores (mesmas views de v17
// usadas em routes/api.js pra não contaminar KPIs com outro marketplace, ver
// decisions.md), nunca `items`/`stores` cru. Pedido explícito do usuário:
// Shopee tem estrutura de tarifa/frete própria e MUITO diferente (ver
// shopee.md) — um "Analista Ecom" equivalente pra Shopee é tarefa futura,
// na página da Shopee, com sua própria fórmula (ver todo.md).
async function listarAnalistaEcom({ store_id = '' } = {}) {
  const { rows } = await pool.query(
    `SELECT i.ml_id, i.store_id, s.nickname AS loja, COALESCE(s.imposto_pct,0) AS imposto_pct, i.title, i.thumbnail, i.price, i.status,
            i.available_quantity, i.cost, i.cost_updated_at, i.category_id, i.margem_alvo_pct AS margem_alvo_pct_override, i.frete AS frete_override,
            ss.visits_30d, ss.sales_30d, ss.conversion_rate, ss.score AS qualidade,
            pcf.fee_percentage AS tarifa_pct, COALESCE(cnc.name, pcf.category_name) AS category_name,
            po.status AS promo_status, po.promo_price, po.discount_pct AS promo_discount_pct
       FROM vw_ml_items i
       JOIN vw_ml_stores s ON s.id = i.store_id
       LEFT JOIN item_seo_score ss ON ss.item_id = i.ml_id
       LEFT JOIN pricing_category_fees pcf ON pcf.category_id = i.category_id
       LEFT JOIN category_names_cache cnc ON cnc.category_id = i.category_id
       LEFT JOIN LATERAL (
         SELECT status, promo_price, discount_pct FROM promotions
          WHERE item_id = i.ml_id ORDER BY changed_at DESC LIMIT 1
       ) po ON true
      WHERE i.status = 'active' AND ($1 = '' OR i.store_id = $1::bigint)
      ORDER BY i.ml_id`,
    [store_id]
  );
  if (!rows.length) return [];
  const cfg = await getConfigGlobal();
  const faseMap = await ranking.buscarFasePorItemIds(rows.map((r) => r.ml_id));
  return rows.map((r) => calcularLinha(r, cfg, faseMap.get(r.ml_id)?.fase || null));
}

// ── Histórico de vendas + visitas de 1 anúncio (modal do card) ──────────
// Série diária dos últimos 30 dias, zero-preenchida (mesmo padrão já usado
// no "Ver vendas" do estágio Catálogo em rankeamento.js — generate_series +
// LEFT JOIN, nunca reconstrói dia faltando com aproximação). Totais de
// 3/7/10/15/21/30 dias (seção do card com o modal) são só a soma dessa
// MESMA série — nunca 6 queries separadas. Visitas vêm de `item_visits`
// (já sincronizada 1x/dia pelo worker), vendas de `orders` (pedidos não
// cancelados).
const JANELAS_HISTORICO = [3, 7, 10, 15, 21, 30];
async function getHistoricoItem(mlId) {
  const { rows } = await pool.query(
    `WITH dias AS (
       SELECT generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day')::date AS dia
     ),
     vendas AS (
       SELECT date_created::date AS dia, COUNT(*)::int AS pedidos, COALESCE(SUM(quantity),0)::int AS unidades
         FROM orders
        WHERE item_id = $1 AND status <> 'cancelled' AND date_created >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY 1
     ),
     visitas AS (
       SELECT date AS dia, visits FROM item_visits WHERE item_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'
     )
     SELECT d.dia, COALESCE(v.pedidos,0) AS pedidos, COALESCE(v.unidades,0) AS unidades, COALESCE(vi.visits,0) AS visitas
       FROM dias d LEFT JOIN vendas v ON v.dia = d.dia LEFT JOIN visitas vi ON vi.dia = d.dia
      ORDER BY d.dia ASC`,
    [mlId]
  );
  const dias = rows.map((r) => ({ data: r.dia.toISOString().slice(0, 10), pedidos: r.pedidos, unidades: r.unidades, visitas: r.visitas }));
  const totais = {};
  for (const janela of JANELAS_HISTORICO) {
    const fatia = dias.slice(-janela);
    totais[janela] = {
      pedidos: fatia.reduce((s, d) => s + d.pedidos, 0),
      unidades: fatia.reduce((s, d) => s + d.unidades, 0),
      visitas: fatia.reduce((s, d) => s + d.visitas, 0),
    };
  }
  return { dias, totais };
}

module.exports = {
  getConfigGlobal, setConfigGlobal,
  getTarifasCategorias, setTarifaCategoria, deleteTarifaCategoria, setMargemAlvoItem, setFreteItem,
  precoParaMargem, margemNoPreco, diagnosticar, calcularLinha, listarAnalistaEcom, getHistoricoItem,
  CONVERSAO_BOA, CONVERSAO_RUIM, VISITAS_30D_RELEVANTES, TOLERANCIA_MARGEM_PP, JANELAS_HISTORICO,
};
