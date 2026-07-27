// Gateway ML de monitoramento de concorrentes. É o ÚNICO ponto que decide a
// fonte do dado do MLB, nesta ordem (cache → API pública SEM token → scraping da
// página → banco). A tela nunca sabe de onde veio. Se o ML mudar as regras,
// muda-se só aqui. O PREÇO é o dado mais importante.
//
// Por que público-primeiro: são anúncios de CONCORRENTES; mandar o Bearer da
// nossa conta gera 403 access_denied e gasta cota — o GET público (sem auth)
// devolve os dados públicos. Estoque/vendas às vezes vêm; visitas NÃO (privadas
// do dono). Ver .claude/analise-produtos.md e known-bugs.md.
const pool = require('../db/pool');
const ml = require('../mlClient');
const { extractMercadoLivreData } = require('../extractors/mercadolivre');

const num = (v) => (v == null || v === '' ? null : Number(v));

// Último recurso quando a API bloqueia (403): lê a PÁGINA PÚBLICA do anúncio
// (sem token) e extrai preço/título/fotos do JSON-LD, igual a extensão faz.
// Best-effort — o ML pode devolver uma página de desafio pra IP de servidor.
async function scrapePermalink(link) {
  const fetch = require('node-fetch');
  const r = await fetch(link, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`página respondeu HTTP ${r.status}`);
  const html = await r.text();
  const jsonLd = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]); } catch (_) { return null; } })
    .filter(Boolean).flat();
  const pageText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 20000);
  const { extracted } = extractMercadoLivreData({ url: link, pageText, jsonLd });
  return extracted;
}

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

// GET público SEM Authorization — item de concorrente costuma dar 403
// access_denied quando mandamos o Bearer de OUTRA conta; sem o header o ML
// devolve o JSON público. É a tentativa mais promissora contra o 403.
async function fetchItemNoAuth(mlId) {
  const fetch = require('node-fetch');
  const r = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(mlId)}`,
    { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`ML API (sem auth) /items/${mlId} -> HTTP ${r.status}`);
  const body = await r.json();
  if (!body || !body.id) throw new Error('item vazio (sem auth)');
  return body;
}

// Busca o item PÚBLICO-PRIMEIRO (recomendação de arquitetura): como são anúncios
// de CONCORRENTES, mandar o Bearer da nossa conta só gera 403 access_denied e
// consome cota à toa. Ordem: 1) SEM token (público), 2) autenticado item único,
// 3) autenticado multiget — os autenticados só como rede de segurança.
async function fetchItem(mlId, storeId) {
  try {
    return await fetchItemNoAuth(mlId); // público, sem Authorization — o caminho certo p/ terceiros
  } catch (_) { /* cai pros autenticados abaixo */ }
  if (storeId) {
    const attrs = 'id,title,price,original_price,available_quantity,sold_quantity,status,listing_type_id,shipping,pictures,permalink,seller_id,health,catalog_listing';
    try {
      const it = await ml.getItem(mlId, storeId);
      if (it && it.id) return it;
    } catch (e) { if (!String(e.message).includes('403')) throw e; }
    const arr = await ml.get(`/items?ids=${encodeURIComponent(mlId)}&attributes=${attrs}`, storeId);
    const body = Array.isArray(arr) ? arr[0]?.body : null;
    if (body && body.id) return body;
  }
  throw new Error(`não consegui ler ${mlId} (público e autenticado falharam)`);
}

// Grava/atualiza o snapshot do dia (upsert) com os campos fornecidos. COALESCE
// preserva o que já existe quando o novo valor vier null — assim tanto a coleta
// via API (dados completos) quanto a via EXTENSÃO (só preço) alimentam o mesmo
// histórico sem se apagarem. Calcula sold_delta contra o último dia anterior.
async function recordSnapshot(mlId, f) {
  f = f || {};
  const soldNow = num(f.sold_quantity);
  let soldDelta = null;
  if (soldNow != null) {
    const { rows: prev } = await pool.query(
      `SELECT sold_quantity FROM analise_monitor_snapshots
        WHERE ml_id=$1 AND snap_date < CURRENT_DATE ORDER BY snap_date DESC LIMIT 1`, [mlId]);
    if (prev[0]?.sold_quantity != null) soldDelta = soldNow - Number(prev[0].sold_quantity);
  }
  await pool.query(
    `INSERT INTO analise_monitor_snapshots
       (ml_id, snap_date, preco, preco_original, status, available_quantity, sold_quantity,
        sold_delta, visits_day, listing_type, logistic_type, free_shipping, health, catalog, seller_id, raw)
     VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (ml_id, snap_date) DO UPDATE SET
       preco=COALESCE(EXCLUDED.preco, analise_monitor_snapshots.preco),
       preco_original=COALESCE(EXCLUDED.preco_original, analise_monitor_snapshots.preco_original),
       status=COALESCE(EXCLUDED.status, analise_monitor_snapshots.status),
       available_quantity=COALESCE(EXCLUDED.available_quantity, analise_monitor_snapshots.available_quantity),
       sold_quantity=COALESCE(EXCLUDED.sold_quantity, analise_monitor_snapshots.sold_quantity),
       sold_delta=COALESCE(EXCLUDED.sold_delta, analise_monitor_snapshots.sold_delta),
       visits_day=COALESCE(EXCLUDED.visits_day, analise_monitor_snapshots.visits_day),
       listing_type=COALESCE(EXCLUDED.listing_type, analise_monitor_snapshots.listing_type),
       logistic_type=COALESCE(EXCLUDED.logistic_type, analise_monitor_snapshots.logistic_type),
       free_shipping=COALESCE(EXCLUDED.free_shipping, analise_monitor_snapshots.free_shipping),
       health=COALESCE(EXCLUDED.health, analise_monitor_snapshots.health),
       catalog=COALESCE(EXCLUDED.catalog, analise_monitor_snapshots.catalog),
       seller_id=COALESCE(EXCLUDED.seller_id, analise_monitor_snapshots.seller_id),
       raw=COALESCE(EXCLUDED.raw, analise_monitor_snapshots.raw)`,
    [mlId, num(f.preco), num(f.preco_original), f.status || null,
     num(f.available_quantity), soldNow, soldDelta, num(f.visits_day),
     f.listing_type || null, f.logistic_type || null, f.free_shipping ?? null,
     num(f.health), f.catalog ?? null, f.seller_id != null ? String(f.seller_id) : null,
     f.raw ? JSON.stringify(f.raw) : null]);
  return { ml_id: mlId, preco: num(f.preco), sold_delta: soldDelta };
}

// Consulta 1 MLB (público) e grava o snapshot do dia. Visitas NÃO entram: são
// privadas do dono do anúncio (o ML não expõe de terceiros — ver known-bugs).
async function snapshotOne(mlId, storeId) {
  const item = await fetchItem(mlId, storeId);
  const ship = item.shipping || {};
  return recordSnapshot(mlId, {
    preco: item.price, preco_original: item.original_price, status: item.status,
    available_quantity: item.available_quantity, sold_quantity: item.sold_quantity,
    listing_type: item.listing_type_id, logistic_type: ship.logistic_type,
    free_shipping: ship.free_shipping, health: item.health, catalog: item.catalog_listing,
    seller_id: item.seller_id, raw: item,
  });
}

// CACHE: já foi consultado nas últimas `hours`? Evita bater na rede à toa.
async function consultadoRecente(mlId, hours) {
  if (!hours) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM analise_monitor_snapshots
      WHERE ml_id=$1 AND created_at > now() - ($2 || ' hours')::interval LIMIT 1`,
    [mlId, String(hours)]);
  return rows.length > 0;
}

// Roda snapshot de vários MLBs em série, com pausa pro rate limit. `maxAgeHours`
// pula MLBs já consultados nesse intervalo (cache — usado pelo job automático).
async function snapshotMany(mlIds, storeId, maxAgeHours = 0) {
  let ok = 0, fail = 0, cache = 0;
  for (const id of mlIds) {
    if (await consultadoRecente(id, maxAgeHours)) { cache++; continue; }
    try { await snapshotOne(id, storeId); ok++; }
    catch (e) { fail++; console.error('[monitor]', id, e.message); }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok, fail, cache, total: mlIds.length };
}

// Snapshot de todos os MLBs de UM produto (rota "Monitorar agora" → força).
async function snapshotProduct(productId) {
  const storeId = await pickMlStoreId(); // pode ser null — o público funciona sem token
  const ids = await distinctMlIds(productId);
  if (!ids.length) return { ok: 0, fail: 0, total: 0 };
  return snapshotMany(ids, storeId, 0);
}

// Snapshot de TODOS os MLBs monitorados (job diário) — respeita cache de 12h.
async function snapshotAll() {
  const storeId = await pickMlStoreId();
  const ids = await distinctMlIds(null);
  console.log(`[monitor] snapshot de ${ids.length} MLBs`);
  return snapshotMany(ids, storeId, 12);
}

// GET completo de 1 MLB → campos do card (título, preço, fotos, vendedor,
// reputação, cidade/estado, nota, nº de comentários/perguntas, FULL/FLEX).
// item é obrigatório; usuário/reviews/perguntas são best-effort (não quebram).
async function getAdDataFromMl(mlId, storeId, link) {
  let item;
  try {
    item = await fetchItem(mlId, storeId); // autenticado → multiget → sem auth
  } catch (e) {
    // API bloqueada (403): tenta a página pública pelo link (preço/título/fotos).
    if (link) {
      const sc = await scrapePermalink(link);
      const promo = num(sc.price?.promotion), normal = num(sc.price?.normal);
      return {
        ml_id: mlId, link,
        titulo: sc.title || null,
        preco: promo != null ? promo : normal,
        preco_original: (promo != null && normal != null && promo !== normal) ? normal : null,
        nota: sc.rating?.nota ?? null,
        comentarios: sc.rating?.opinioes ?? null,
        vendas: sc.salesCount?.texto || null,
        fotos: sc.images?.principal ? [sc.images.principal, ...(sc.images.secundarias || [])].filter(Boolean) : null,
        _source: 'pagina',
      };
    }
    throw e;
  }
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

module.exports = { snapshotOne, snapshotProduct, snapshotAll, pickMlStoreId, getAdDataFromMl, recordSnapshot };
