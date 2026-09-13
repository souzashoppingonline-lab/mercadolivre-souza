// TaskEngine — lógica centralizada de geração automática de cartões da Agenda
// Trello. Nenhuma página/worker deve montar um INSERT em `tasks` diretamente;
// tudo passa por aqui. Ver .claude/task-engine.md para a arquitetura completa.
const pool = require('./db/pool');

// Mesmo limiar já usado em handleItem() pro alerta Telegram tg_reposicao —
// reaproveitado aqui em vez de criar um novo threshold configurável, já que
// o módulo é independente mas a regra de negócio ("estoque crítico") é a
// mesma que o sistema já usa.
const STOCK_CRITICAL_THRESHOLD = 5;
const QUALITY_SCORE_THRESHOLD = 50;
// v97 (Shopee): limiar inicial de "vendendo bem" — unidades de UM anúncio
// nas últimas 24h. Sem histórico/baseline por item ainda (diferente do
// outlier estatístico de faturamento da loja, que já usa desvio-padrão);
// começa fixo e ajustável, mesmo espírito de outros limiares "iniciais"
// deste projeto (ex.: CONCILIACAO_DIFERENCA_ALERTA_PCT).
const VENDA_FORTE_UNIDADES_24H = 10;

// Cache por código de marketplace (era só ML — v97 generaliza pra Shopee/
// Amazon usarem o mesmo TaskEngine sem duplicar o módulo).
const marketplaceIdCache = {};
async function getMarketplaceId(code) {
  if (marketplaceIdCache[code]) return marketplaceIdCache[code];
  const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code=$1`, [code]);
  marketplaceIdCache[code] = rows[0]?.id ?? null;
  return marketplaceIdCache[code];
}

// Dedup: se já existe cartão para essa regra+item em QUALQUER status que não
// seja excluído (a_fazer, em_andamento ou até finalizado), só atualiza a
// data/metadata em vez de duplicar. Só volta a criar um cartão novo depois
// que o anterior for movido pra Excluído.
async function createTaskIfNotExists({ ruleKey, itemId, title, description, priority, storeId, source = 'mercado_livre', marketplaceCode = 'ML', metadata = {} }) {
  const marketplaceId = await getMarketplaceId(marketplaceCode);
  const { rows: existing } = await pool.query(
    `SELECT id FROM tasks WHERE rule_key=$1 AND item_id=$2 AND board_column != 'excluido' LIMIT 1`,
    [ruleKey, itemId]
  );
  if (existing.length) {
    await pool.query(`UPDATE tasks SET updated_at=now(), metadata=$2 WHERE id=$1`, [existing[0].id, JSON.stringify(metadata)]);
    return { id: existing[0].id, created: false };
  }
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, board_column, priority, marketplace_id, store_id, item_id, source, rule_key, metadata)
     VALUES ($1,$2,'a_fazer',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [title, description, priority, marketplaceId, storeId, itemId, source, ruleKey, JSON.stringify(metadata)]
  );
  return { id: rows[0].id, created: true };
}

// Regra 1 — Estoque crítico. Chamada de handleItem() em worker.js (ML) e de
// syncShopeeCatalog (marketplaceEventWorker, v97). MESMO rule_key pras duas
// origens — é literalmente a mesma regra de negócio, só a fonte do dado
// muda; um item_id de Shopee nunca colide com um MLB, então o dedup
// (rule_key+item_id) continua correto mesclando as duas filas numa só.
async function checkStock({ itemId, title, availableQuantity, permalink, storeId, storeName, marketplace = 'Mercado Livre', marketplaceCode = 'ML', source = 'mercado_livre' }) {
  if (availableQuantity == null || availableQuantity > STOCK_CRITICAL_THRESHOLD) return null;
  try {
    return await createTaskIfNotExists({
      ruleKey: 'estoque_critico',
      itemId,
      title: `Repor estoque urgente: ${title || itemId}`,
      description: `O anúncio ${itemId} atingiu estoque crítico (restam ${availableQuantity} un.).`,
      priority: 'alta',
      storeId,
      source,
      marketplaceCode,
      metadata: {
        sku: itemId, titulo: title, quantidade: availableQuantity,
        loja: storeName, marketplace, link: permalink,
      },
    });
  } catch (e) {
    console.warn(`[task-engine] checkStock falhou para ${itemId}: ${e.message}`);
    return null;
  }
}

// Regra 2 — Score de qualidade abaixo de 50. Chamada de syncScores() em worker.js.
async function checkQuality({ itemId, title, score, problems, permalink, storeId, storeName }) {
  if (score == null || score >= QUALITY_SCORE_THRESHOLD) return null;
  try {
    return await createTaskIfNotExists({
      ruleKey: 'score_baixo',
      itemId,
      title: `Melhorar qualidade: ${title || itemId}`,
      description: `O anúncio possui qualidade abaixo de 50 (score atual: ${score}).`,
      priority: 'media',
      storeId,
      metadata: {
        scoreAtual: score, problemas: problems || [],
        loja: storeName, marketplace: 'Mercado Livre', link: permalink, titulo: title,
      },
    });
  } catch (e) {
    console.warn(`[task-engine] checkQuality falhou para ${itemId}: ${e.message}`);
    return null;
  }
}

// Regra 3 (v97, Shopee) — Produto vendendo bem: >= VENDA_FORTE_UNIDADES_24H
// unidades de UM anúncio nas últimas 24h. Chamada por checkShopeeVendasFortes
// (marketplaceEventWorker, a cada 4h). Prioridade 'media' — é oportunidade
// (ex.: evitar ruptura, considerar ADS), não um problema.
async function checkVendaForte({ itemId, title, unidades24h, storeId, storeName, link }) {
  if (unidades24h == null || unidades24h < VENDA_FORTE_UNIDADES_24H) return null;
  try {
    return await createTaskIfNotExists({
      ruleKey: 'venda_forte_shopee',
      itemId,
      title: `Produto vendendo bem: ${title || itemId}`,
      description: `${unidades24h} unidade(s) vendida(s) nas últimas 24h — considere garantir estoque e avaliar ADS/preço.`,
      priority: 'media',
      storeId,
      source: 'shopee',
      marketplaceCode: 'SHOPEE',
      metadata: { sku: itemId, titulo: title, unidades24h, loja: storeName, marketplace: 'Shopee', link },
    });
  } catch (e) {
    console.warn(`[task-engine] checkVendaForte falhou para ${itemId}: ${e.message}`);
    return null;
  }
}

// Regra 4 (v97, Shopee) — Promoção/cupom/oferta relâmpago ATIVA. Chamada por
// syncShopeePromos (marketplaceEventWorker, 1h) pra cada promoção que virou
// 'ongoing'. item_id = promo_id (não colide entre tipos porque discount_id e
// voucher_id vivem em espaços separados na Shopee, e o rule_key já é único
// por tipo). "Oferta relâmpago" aqui = campanha tipo 'discount' (a Shopee
// tem uma API de Flash Sale própria, ainda NÃO integrada neste projeto —
// ver shopee.md; até lá, 'discount' é o mais próximo do que já sincronizamos).
async function checkPromoAtiva({ tipo, promoId, nome, desconto, storeId, storeName }) {
  try {
    const rotulo = tipo === 'discount' ? 'Oferta relâmpago' : 'Cupom';
    return await createTaskIfNotExists({
      ruleKey: 'promocao_ativa_shopee',
      itemId: String(promoId),
      title: `${rotulo} ativa: ${nome || promoId}`,
      description: `Campanha ${tipo === 'discount' ? 'de desconto' : 'de cupom'} em andamento na Shopee${desconto ? ` (${desconto})` : ''}.`,
      priority: 'baixa',
      storeId,
      source: 'shopee',
      marketplaceCode: 'SHOPEE',
      metadata: { tipo, promoId, nome, desconto, loja: storeName, marketplace: 'Shopee' },
    });
  } catch (e) {
    console.warn(`[task-engine] checkPromoAtiva falhou para ${promoId}: ${e.message}`);
    return null;
  }
}

// Regra 5 (v97, Shopee) — Promoção vencendo/vencida. Chamada por
// checkShopeeCampanhasVencendo (worker.js, 1x/dia), reaproveitando o MESMO
// cálculo de dias restantes já usado pro alerta Telegram/e-mail — não
// recalcula nada aqui, só transforma o aviso que já existe num cartão.
async function checkPromoVencendo({ tipo, promoId, nome, storeId, storeName, diasRestantes, vencida }) {
  try {
    const titulo = vencida ? `Promoção vencida: ${nome || promoId}` : `Promoção vencendo em ${diasRestantes}d: ${nome || promoId}`;
    return await createTaskIfNotExists({
      ruleKey: 'promocao_vencendo_shopee',
      itemId: String(promoId),
      title: titulo,
      description: vencida
        ? `A campanha ${tipo === 'discount' ? 'de desconto' : 'de cupom'} já venceu — renove ou remova.`
        : `Faltam ${diasRestantes} dia(s) pro fim da campanha — decida se renova.`,
      priority: vencida ? 'alta' : 'media',
      storeId,
      source: 'shopee',
      marketplaceCode: 'SHOPEE',
      metadata: { tipo, promoId, nome, diasRestantes, vencida, loja: storeName, marketplace: 'Shopee' },
    });
  } catch (e) {
    console.warn(`[task-engine] checkPromoVencendo falhou para ${promoId}: ${e.message}`);
    return null;
  }
}

module.exports = { checkStock, checkQuality, checkVendaForte, checkPromoAtiva, checkPromoVencendo, createTaskIfNotExists };
