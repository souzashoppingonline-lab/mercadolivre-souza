// Monitoramento de concorrentes — snapshot diário de cada MLB coletado, via API
// do Mercado Livre. O PREÇO é o dado mais importante; também guardamos estoque,
// vendas acumuladas (+ delta do dia), visitas, tipo de anúncio e frete.
// Usado pelo job diário do worker e pela rota "Monitorar agora". Ver
// .claude/analise-produtos.md.
const pool = require('../db/pool');
const ml = require('../mlClient');

const num = (v) => (v == null || v === '' ? null : Number(v));

// Escolhe uma loja ML com token OAuth pra consultar itens de terceiros (a
// consulta é de dados públicos; qualquer token válido serve). ML tirou o acesso
// anônimo, por isso precisa de um token.
async function pickMlStoreId() {
  const { rows } = await pool.query(
    `SELECT id FROM stores
      WHERE access_token IS NOT NULL AND token_expires_at IS NOT NULL
      ORDER BY id LIMIT 1`);
  return rows[0]?.id ?? null;
}

// MLBs distintos a monitorar (só anúncios com ml_id e monitorar=true).
async function distinctMlIds(productId) {
  const cond = productId ? 'AND product_id = $1' : '';
  const { rows } = await pool.query(
    `SELECT DISTINCT ml_id FROM analise_product_ads
      WHERE ml_id IS NOT NULL AND (monitorar IS NULL OR monitorar = true) ${cond}`,
    productId ? [productId] : []);
  return rows.map((r) => r.ml_id);
}

// Consulta 1 MLB e grava o snapshot do dia (upsert). Calcula sold_delta contra o
// último snapshot de um dia anterior.
async function snapshotOne(mlId, storeId) {
  const item = await ml.getItem(mlId, storeId);
  if (!item || !item.id) throw new Error('item vazio');
  const ship = item.shipping || {};

  // Visitas do dia (best-effort — não quebra o snapshot se falhar).
  let visits = null;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const v = await ml.getItemVisits(mlId, hoje, storeId);
    visits = v?.total_visits ?? (Array.isArray(v?.results)
      ? v.results.reduce((s, r) => s + (r.total || r.visits || 0), 0) : null);
  } catch (_) { /* ignore */ }

  const soldNow = num(item.sold_quantity);
  const { rows: prev } = await pool.query(
    `SELECT sold_quantity FROM analise_monitor_snapshots
      WHERE ml_id = $1 AND snap_date < CURRENT_DATE
      ORDER BY snap_date DESC LIMIT 1`, [mlId]);
  const soldDelta = (soldNow != null && prev[0]?.sold_quantity != null)
    ? soldNow - Number(prev[0].sold_quantity) : null;

  await pool.query(
    `INSERT INTO analise_monitor_snapshots
       (ml_id, snap_date, preco, preco_original, status, available_quantity, sold_quantity,
        sold_delta, visits_day, listing_type, logistic_type, free_shipping, health, catalog, seller_id, raw)
     VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (ml_id, snap_date) DO UPDATE SET
       preco=EXCLUDED.preco, preco_original=EXCLUDED.preco_original, status=EXCLUDED.status,
       available_quantity=EXCLUDED.available_quantity, sold_quantity=EXCLUDED.sold_quantity,
       sold_delta=EXCLUDED.sold_delta, visits_day=EXCLUDED.visits_day, listing_type=EXCLUDED.listing_type,
       logistic_type=EXCLUDED.logistic_type, free_shipping=EXCLUDED.free_shipping, health=EXCLUDED.health,
       catalog=EXCLUDED.catalog, seller_id=EXCLUDED.seller_id, raw=EXCLUDED.raw`,
    [mlId, num(item.price), num(item.original_price), item.status || null,
     num(item.available_quantity), soldNow, soldDelta, visits,
     item.listing_type_id || null, ship.logistic_type || null,
     ship.free_shipping ?? null, num(item.health), item.catalog_listing ?? null,
     item.seller_id != null ? String(item.seller_id) : null, JSON.stringify(item)]);

  return { ml_id: mlId, preco: num(item.price), sold_delta: soldDelta, visits_day: visits, status: item.status };
}

// Roda snapshot de vários MLBs em série, com pausa pra respeitar o rate limit.
async function snapshotMany(mlIds, storeId) {
  let ok = 0, fail = 0;
  for (const id of mlIds) {
    try { await snapshotOne(id, storeId); ok++; }
    catch (e) { fail++; console.error('[monitor]', id, e.message); }
    await new Promise((r) => setTimeout(r, 800)); // pausa entre chamadas
  }
  return { ok, fail, total: mlIds.length };
}

// Snapshot de todos os MLBs de UM produto (usado pela rota "Monitorar agora").
async function snapshotProduct(productId) {
  const storeId = await pickMlStoreId();
  if (!storeId) throw new Error('nenhuma loja ML conectada (sem token) para consultar a API do Mercado Livre');
  const ids = await distinctMlIds(productId);
  if (!ids.length) return { ok: 0, fail: 0, total: 0 };
  return snapshotMany(ids, storeId);
}

// Snapshot de TODOS os MLBs monitorados (job diário do worker).
async function snapshotAll() {
  const storeId = await pickMlStoreId();
  if (!storeId) { console.log('[monitor] sem loja ML com token — pulando'); return { ok: 0, fail: 0, total: 0 }; }
  const ids = await distinctMlIds(null);
  console.log(`[monitor] snapshot de ${ids.length} MLBs`);
  return snapshotMany(ids, storeId);
}

// GET completo de 1 MLB → campos do card (título, preço, fotos, vendedor,
// reputação, cidade/estado, nota, nº de comentários/perguntas, FULL/FLEX).
// item é obrigatório; usuário/reviews/perguntas são best-effort (não quebram).
async function getAdDataFromMl(mlId, storeId) {
  const item = await ml.getItem(mlId, storeId);
  if (!item || !item.id) throw new Error('item vazio');
  const ship = item.shipping || {};
  const fotos = Array.isArray(item.pictures)
    ? item.pictures.map((p) => p.secure_url || p.url).filter(Boolean) : null;
  const out = {
    ml_id: item.id, link: item.permalink || null, titulo: item.title || null,
    preco: num(item.price), preco_original: num(item.original_price),
    vendas: item.sold_quantity != null ? `${item.sold_quantity} vendidos` : null,
    full: ship.logistic_type === 'fulfillment' ? true : (ship.logistic_type ? false : null),
    flex: ship.logistic_type === 'self_service' ? true : (ship.logistic_type ? false : null),
    fotos: fotos && fotos.length ? fotos : null,
  };
  // Vendedor + reputação + cidade/estado
  try {
    if (item.seller_id) {
      const u = await ml.get(`/users/${item.seller_id}`, storeId);
      out.vendedor = u?.nickname || null;
      const rep = u?.seller_reputation || {};
      const pss = rep.power_seller_status
        ? ({ platinum: 'Platinum', gold: 'Gold', silver: 'Silver' }[rep.power_seller_status] || rep.power_seller_status)
        : '';
      out.reputacao = [pss ? `MercadoLíder ${pss}` : '', rep.level_id || ''].filter(Boolean).join(' ') || null;
      out.cidade = u?.address?.city || null;
      out.estado = u?.address?.state || null;
    }
  } catch (_) { /* best-effort */ }
  // Nota + nº de opiniões
  try {
    const rv = await ml.get(`/reviews/item/${mlId}`, storeId);
    if (rv?.rating_average != null) out.nota = num(rv.rating_average);
    const tot = rv?.paging?.total ?? (Array.isArray(rv?.reviews) ? rv.reviews.length : null);
    if (tot != null) out.comentarios = num(tot);
  } catch (_) { /* best-effort */ }
  // Perguntas (total)
  try {
    const q = await ml.get(`/questions/search?item=${mlId}&limit=0`, storeId);
    if (q?.total != null) out.perguntas = num(q.total);
  } catch (_) { /* best-effort */ }
  return out;
}

module.exports = { snapshotOne, snapshotProduct, snapshotAll, pickMlStoreId, getAdDataFromMl };
