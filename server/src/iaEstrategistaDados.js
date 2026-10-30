// IA Estrategista — coleta/consolidação dos dados + carteira analisada (com
// cache) + antes×depois das ações. Compartilhado pela rota
// (routes/iaEstrategista.js) e pelos jobs do worker (Telegram 08:05, críticos,
// ações paradas, resultado automático). Motor puro em iaEstrategista.js.
const pool = require('./db/pool');
const { cached } = require('./db/cached');
const { VENDA_DETALHE_SELECT, calcularMargemLinha, buscarImpostoFlexAtivo, buscarFreteMotoboy } = require('./vendaMargem');
const { getConfigGlobal } = require('./analistaEcom');
const { classificar: classificarBuybox } = require('../../js/buyboxStatus');
const motor = require('./iaEstrategista');

const PERIODOS = [7, 14, 30];
const HISTORICO_DIAS = 60;          // 2 × maior período
const CACHE_TTL = 600;              // 10 min — carteira inteira
const diaSP = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const ontemSP = () => motor.addDias(diaSP(new Date()), -1);

async function coletar({ storeId }) {
  const p = []; let filtro = '';
  if (storeId) { p.push(storeId); filtro = `AND ra.store_id = $${p.length}::bigint`; }
  const { rows: ads } = await pool.query(
    `SELECT ra.id, ra.ml_id, ra.fase, ra.store_id, ra.ads_investido, ra.roas, ra.orcamento_diario, ra.campanha_nome,
            COALESCE(i.title, ra.title) AS titulo, i.available_quantity, i.status, i.price, i.permalink, i.thumbnail,
            (i.cost_updated_at IS NULL) AS custo_ausente, i.margem_alvo_pct, s.nickname AS loja
       FROM ranking_ads ra
       LEFT JOIN items i ON i.ml_id = ra.ml_id
       LEFT JOIN stores s ON s.id = ra.store_id
      WHERE ra.active = true ${filtro}`, p);
  if (!ads.length) return { cfg: null, anuncios: [] };
  const adIds = ads.map(a => a.id);
  const { rows: links } = await pool.query(`SELECT ranking_ad_id, ml_id FROM ranking_ad_links WHERE ranking_ad_id = ANY($1::int[])`, [adIds]);
  const itemParaAd = new Map(ads.map(a => [a.ml_id, a.id]));
  links.forEach(l => { if (!itemParaAd.has(l.ml_id)) itemParaAd.set(l.ml_id, l.ranking_ad_id); });
  const itemIds = [...itemParaAd.keys()];
  const desde = motor.addDias(diaSP(new Date()), -HISTORICO_DIAS);

  const [impostoFlexAtivo, freteMotoboy, cfg] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy(), getConfigGlobal()]);
  const [{ rows: pedidos }, { rows: visitas }, { rows: catalogo }] = await Promise.all([
    pool.query(
      `-- ia-estrategista
       ${VENDA_DETALHE_SELECT}
       WHERE o.status <> 'cancelled' AND o.date_created >= $1::date AND o.item_id = ANY($2::text[])
       ORDER BY o.date_created DESC LIMIT 50000`, [desde, itemIds]),
    pool.query(`SELECT item_id, date::text AS dia, visits FROM item_visits WHERE item_id = ANY($1::text[]) AND date >= $2::date`, [itemIds, desde]),
    pool.query(`SELECT item_id, status, winner_item_id, winner_price, price_to_win, calculated_at FROM catalog_competition WHERE item_id = ANY($1::text[])`, [ads.map(a => a.ml_id)]),
  ]);

  const porAd = new Map(ads.map(a => [a.id, { dias: {}, visitas: {}, sku: null }]));
  for (const raw of pedidos) {
    const adId = itemParaAd.get(raw.item_id); if (!adId) continue;
    const r = calcularMargemLinha(raw, impostoFlexAtivo, freteMotoboy);
    const acc = porAd.get(adId);
    const d = diaSP(r.date_created);
    const x = acc.dias[d] || (acc.dias[d] = { pedidos: 0, unidades: 0, fat: 0, margem: 0, custo: 0, tarifa: 0, frete: 0 });
    x.pedidos += 1; x.unidades += Number(r.quantity) || 0; x.fat += Number(r.faturamento) || 0; x.margem += r.margem;
    x.custo += r.custo; x.tarifa += r.tarifa; x.frete += r.freteVend + (Number(r.frete_comprador) || 0);
    if (!acc.sku && r.sku) acc.sku = r.sku; // pedidos vêm do mais novo pro mais velho
  }
  for (const v of visitas) {
    const adId = itemParaAd.get(v.item_id); if (!adId) continue;
    const acc = porAd.get(adId);
    acc.visitas[v.dia] = (acc.visitas[v.dia] || 0) + (Number(v.visits) || 0);
  }
  const bb = new Map(catalogo.map(c => [c.item_id, c]));
  return {
    cfg,
    anuncios: ads.map(a => {
      const acc = porAd.get(a.id);
      const c = bb.get(a.ml_id);
      const st = c ? classificarBuybox({ calculado_em: c.calculated_at, winner_item_id: c.winner_item_id, item_id: c.item_id, status: c.status }) : null;
      return {
        ranking_ad_id: a.id, ml_id: a.ml_id, titulo: a.titulo, sku: acc.sku, loja: a.loja, store_id: a.store_id, fase: a.fase || 'rankeando',
        estoque: a.available_quantity, preco: a.price != null ? Number(a.price) : null, status_anuncio: a.status,
        permalink: a.permalink, thumbnail: a.thumbnail, custo_ausente: !!a.custo_ausente,
        margem_alvo_pct: a.margem_alvo_pct != null ? Number(a.margem_alvo_pct) : null,
        ads: { investido: a.ads_investido != null ? Number(a.ads_investido) : null, roas: a.roas != null ? Number(a.roas) : null, orcamento_diario: a.orcamento_diario != null ? Number(a.orcamento_diario) : null, campanha: a.campanha_nome },
        buybox: st && c ? { chave: st.chave, label: st.label, winner_price: c.winner_price, price_to_win: c.price_to_win } : null,
        dias: acc.dias, visitas: acc.visitas,
      };
    }),
  };
}

function parse(q) {
  const periodo = PERIODOS.includes(Number(q.days)) ? Number(q.days) : 14;
  const storeId = q.store_id && /^\d+$/.test(String(q.store_id)) ? String(q.store_id) : '';
  return { periodo, storeId };
}
async function carteira({ periodo, storeId, semCache = false }) {
  const fim = ontemSP();
  const calc = async () => {
    const dados = await coletar({ storeId });
    if (!dados.anuncios.length) return { periodo: { dias: periodo, de: motor.addDias(fim, -(periodo - 1)), ate: fim }, painel: { analisados: 0 }, respostas: {}, anuncios: [] };
    return motor.analisarCarteira(dados.anuncios, { periodo, fim, cfg: dados.cfg });
  };
  if (semCache) return calc();
  return cached(`ia-estrategista:${periodo}:${storeId || 'all'}:${fim}`, CACHE_TTL, calc);
}

// Antes × depois OBSERVADO de uma ação concluída: 14 dias fechados antes de
// executada_em vs. desde então, em taxa por dia (mesma janela de
// business_insights/Recuperação). Associação temporal, NÃO causalidade.
async function comAntesDepois(acoes) {
  const concl = acoes.filter(a => a.status === 'concluida' && a.executada_em);
  if (!concl.length) return acoes;
  const [impostoFlexAtivo, freteMotoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
  const adIds = [...new Set(concl.map(a => a.ranking_ad_id))];
  const { rows: itens } = await pool.query(
    `SELECT id AS ranking_ad_id, ml_id FROM ranking_ads WHERE id = ANY($1::int[])
     UNION SELECT ranking_ad_id, ml_id FROM ranking_ad_links WHERE ranking_ad_id = ANY($1::int[])`, [adIds]);
  const itemParaAd = new Map(itens.map(i => [i.ml_id, i.ranking_ad_id]));
  const desde = new Date(Math.min(...concl.map(a => new Date(a.executada_em).getTime())) - 15 * 86400000).toISOString();
  const [{ rows: pedidos }, { rows: visitas }] = await Promise.all([
    pool.query(`${VENDA_DETALHE_SELECT} WHERE o.status <> 'cancelled' AND o.date_created >= $1 AND o.item_id = ANY($2::text[]) LIMIT 50000`, [desde, [...itemParaAd.keys()]]),
    pool.query(`SELECT item_id, date, visits FROM item_visits WHERE item_id = ANY($1::text[]) AND date >= $2::date`, [[...itemParaAd.keys()], desde.slice(0, 10)]),
  ]);
  const linhas = pedidos.map(p => ({ ...calcularMargemLinha(p, impostoFlexAtivo, freteMotoboy), ad: itemParaAd.get(p.item_id), t: new Date(p.date_created).getTime() }));
  const vis = visitas.map(v => ({ ad: itemParaAd.get(v.item_id), t: new Date(v.date).getTime(), n: Number(v.visits) || 0 }));
  const agora = Date.now();
  return acoes.map(a => {
    if (a.status !== 'concluida' || !a.executada_em) return a;
    const t0 = new Date(a.executada_em).getTime();
    const diasDepois = Math.max(1, (agora - t0) / 86400000);
    const janela = (ini, fim, dias) => {
      const ls = linhas.filter(l => l.ad === a.ranking_ad_id && l.t >= ini && l.t < fim);
      const fat = ls.reduce((s, l) => s + (Number(l.faturamento) || 0), 0), mg = ls.reduce((s, l) => s + l.margem, 0);
      const v = vis.filter(x => x.ad === a.ranking_ad_id && x.t >= ini && x.t < fim).reduce((s, x) => s + x.n, 0);
      return { pedidos_dia: +(ls.length / dias).toFixed(2), fat_dia: +(fat / dias).toFixed(2), margem_dia: +(mg / dias).toFixed(2), mc_pct: fat > 0 ? +((mg / fat) * 100).toFixed(1) : null, conversao: v > 0 ? +((ls.length / v) * 100).toFixed(2) : null };
    };
    return { ...a, antes_depois: { antes: janela(t0 - 14 * 86400000, t0, 14), depois: janela(t0, agora, diasDepois), dias_depois: Math.floor(diasDepois),
      aviso: 'Efeito OBSERVADO depois da ação (associação temporal) — NÃO prova que a ação causou a mudança.' } };
  });
}

module.exports = { coletar, parse, carteira, comAntesDepois, PERIODOS, diaSP };
