// Análise de Produtos — rotas PÚBLICAS consumidas pela extensão Chrome.
// Montadas antes do gate de staff (a extensão é externa). A extensão NUNCA
// pergunta pra qual produto enviar: lê o produto ativo daqui. Ver .claude/analise-produtos.md.
const express = require('express');
const pool = require('../db/pool');
const wsHub = require('../ws/hub');
const { num, upsertAd } = require('../analise/ads');
const { extractMercadoLivreData } = require('../extractors/mercadolivre');
const ml = require('../mlClient');
const { pickMlStoreId } = require('../analise/monitor');

// Localização autoritativa do vendedor via API do ML (/users/:id). O endereço do
// vendedor é dado público; qualquer token serve. state vem como "BR-<UF>".
async function sellerLocation(sellerId) {
  try {
    if (!sellerId) return null;
    const storeId = await pickMlStoreId();
    const u = await ml.get(`/users/${sellerId}`, storeId);
    const a = (u && u.address) || {};
    const cidade = (a.city && (a.city.name || a.city)) || null;
    let estado = (a.state && (a.state.id || a.state.name || a.state)) || null;
    if (estado && /^BR-/i.test(estado)) estado = estado.slice(3).toUpperCase();
    return (cidade || estado) ? { cidade, estado } : null;
  } catch (e) { console.error('[extension] sellerLocation', e.message); return null; }
}

// Resolve o id do vendedor pelo APELIDO (nickname) via busca do ML — fonte
// confiável quando o seller_id não veio da página. Devolve id numérico ou null.
async function sellerIdByNickname(nick) {
  try {
    if (!nick) return null;
    const storeId = await pickMlStoreId();
    const r = await ml.get(`/sites/MLB/search?nickname=${encodeURIComponent(nick)}&limit=1`, storeId);
    return (r && r.seller && r.seller.id) || (r && r.results && r.results[0] && r.results[0].seller && r.results[0].seller.id) || null;
  } catch (e) { console.error('[extension] sellerIdByNickname', e.message); return null; }
}

const router = express.Router();

// GET /extension/produto-ativo — qual produto está em coleta agora.
router.get('/produto-ativo', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.produto, p.status
         FROM analise_active_collection ac
         JOIN analise_products p ON p.id = ac.product_id
        WHERE ac.id = 1`);
    res.json({ produto: rows[0] || null });
  } catch (e) { console.error('[extension] produto-ativo', e.message); res.status(500).json({ error: e.message }); }
});

// Monta o payload do anúncio a partir do corpo recebido da extensão (rawData
// da página OU campos já prontos), incluindo a resolução de cidade/estado do
// vendedor pela API do ML. Extraído pra ser reusado pelos dois fluxos: coleta
// manual (produto ativo) e monitoramento automático em background.
async function resolveAdPayload(b) {
    let payload;
    if (b.rawData) {
      const { extracted } = extractMercadoLivreData(b.rawData);
      const price = extracted.price || {};
      const promo = num(price.promotion), normal = num(price.normal);
      const preco = promo != null ? promo : normal;
      const preco_original = (promo != null && normal != null && promo !== normal) ? normal : null;
      const imgs = extracted.images || {};
      const fotos = [imgs.principal, ...(imgs.secundarias || [])].filter(Boolean);
      const m = String(b.rawData.url || '').match(/MLB-?(\d+)/i);
      const ex = b.rawData.extracted || {};        // campos já parseados pela extensão v2
      const exLoc = ex.location || null;           // {cidade, estado} do seller_address
      payload = {
        ml_id: m ? ('MLB' + m[1]) : null,
        link: b.rawData.url || null,
        titulo: extracted.title || null,
        preco, preco_original,
        nota: extracted.rating && extracted.rating.nota != null ? extracted.rating.nota : null,
        vendas: extracted.salesCount && extracted.salesCount.texto ? extracted.salesCount.texto : null,
        perguntas: extracted.questionsCount != null ? extracted.questionsCount : null,
        comentarios: extracted.commentsCount != null ? extracted.commentsCount
                     : (extracted.rating && extracted.rating.opinioes != null ? extracted.rating.opinioes : null),
        vendedor: ex.seller || extracted.seller || null,
        reputacao: ex.reputation || extracted.reputation || null,
        descricao: ex.description || null,
        highlights: Array.isArray(ex.highlights) ? ex.highlights : null,
        full: (ex.full != null ? ex.full : (extracted.shipping ? extracted.shipping.full : null)),
        flex: extracted.shipping ? extracted.shipping.flex : null,
        // Localização: a extensão v2 lê city/state (nome) do estado embutido do
        // ML e manda em extracted.location {cidade, estado} — mais confiável que
        // o pageText. Fallback pro extrator do servidor.
        cidade: (exLoc && exLoc.cidade) || (extracted.location ? extracted.location.cidade : null),
        estado: (exLoc && exLoc.estado) || (extracted.location ? extracted.location.estado : null),
        comentarios_auto: extracted.commentsText || null,
        fotos,
        raw: b.rawData,
      };
    } else {
      payload = b; // campos já prontos
    }
    // Se ainda faltar cidade/estado, busca a localização autoritativa do vendedor
    // na API do ML: 1º pelo seller_id (se veio da página), senão pelo APELIDO.
    let via = (payload.cidade || payload.estado) ? 'pagina' : null;
    if (!payload.cidade || !payload.estado) {
      const ex2 = (b.rawData && b.rawData.extracted) || {};
      let sid = ex2.sellerId;
      if (!sid && payload.vendedor) sid = await sellerIdByNickname(payload.vendedor);
      if (sid) {
        const loc = await sellerLocation(sid);
        if (loc) { payload.cidade = payload.cidade || loc.cidade; payload.estado = payload.estado || loc.estado; via = 'api'; }
      }
    }
    console.log('[extension] loc:', JSON.stringify({ ml_id: payload.ml_id, cidade: payload.cidade, estado: payload.estado, via, sellerId: (b.rawData?.extracted?.sellerId) || null, vendedor: payload.vendedor }));
    return payload;
}

// Carimba a última recoleta. Best-effort: se a migration v66 (coluna
// last_checked_at) ainda não rodou, o erro é ignorado e a coleta NÃO quebra.
async function stampChecked(adId) {
  if (!adId) return;
  try { await pool.query(`UPDATE analise_product_ads SET last_checked_at = now() WHERE id = $1`, [adId]); }
  catch (e) { console.warn('[extension] stampChecked (rodar migration v66?):', e.message); }
}

// Grava o preço lido da PÁGINA no histórico de monitoramento (a API do ML dá
// 403 pra item de concorrente, então a página é a única fonte). Best-effort.
function feedSnapshot(ad) {
  if (ad && ad.ml_id && ad.preco != null) {
    require('../analise/monitor').recordSnapshot(ad.ml_id, { preco: ad.preco, preco_original: ad.preco_original }).catch(() => {});
  }
}

// POST /extension/anuncio — grava o anúncio coletado no produto ATIVO.
// Aceita `rawData` (HTML/texto da página → o servidor extrai) ou campos já prontos.
router.post('/anuncio', async (req, res) => {
  try {
    const { rows: acr } = await pool.query(`SELECT product_id FROM analise_active_collection WHERE id=1`);
    const pid = acr[0]?.product_id;
    if (!pid) return res.status(409).json({ error: 'nenhum produto ativo — ative a coleta no dashboard' });
    const payload = await resolveAdPayload(req.body || {});
    const ad = await upsertAd(pid, payload);
    await stampChecked(ad.id); // best-effort — não pode derrubar a coleta
    feedSnapshot(ad);
    wsHub.publish('analise_anuncio', { produto_id: pid, anuncio: ad }).catch(() => {});
    res.json({ ok: true, produto_id: pid, anuncio: ad });
  } catch (e) { console.error('[extension] POST anuncio', e.message); res.status(500).json({ error: e.message }); }
});

// GET /extension/monitoramento/proximos?limit=N — fila de concorrentes a
// recoletar (background da extensão). Devolve os `monitorar=true` mais
// desatualizados (recoleta 1×/dia): last_checked_at nulo ou > 24h. Deduplica por
// ml_id (o mesmo concorrente pode estar em vários produtos). Ver analise-produtos.md.
router.get('/monitoramento/proximos', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || (force ? 100 : 5), 1), 200);
    // force=1 ignora o corte de 24h (recoleta TODOS os monitorados agora).
    const dueCond = force ? '' : `AND (last_checked_at IS NULL OR last_checked_at < now() - interval '24 hours')`;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ml_id) ml_id, link AS url
         FROM analise_product_ads
        WHERE ml_id IS NOT NULL AND COALESCE(monitorar, true) = true
          AND link IS NOT NULL AND btrim(link) <> ''  -- precisa do permalink pra abrir (sem link a URL fica inválida)
          ${dueCond}
        ORDER BY ml_id, last_checked_at NULLS FIRST
        LIMIT $1`, [limit]);
    res.json({ itens: rows });
  } catch (e) { console.error('[extension] monitoramento/proximos', e.message); res.status(500).json({ error: e.message }); }
});

// POST /extension/monitoramento — recebe um concorrente coletado em background.
// Diferente do /anuncio: NÃO depende do produto ativo; casa pelo ml_id e
// atualiza o anúncio em TODOS os produtos onde ele é monitorado (o mesmo
// concorrente pode aparecer em vários dos seus produtos), sempre carimbando o
// last_checked_at e alimentando o histórico de preço.
router.post('/monitoramento', async (req, res) => {
  try {
    const payload = await resolveAdPayload(req.body || {});
    if (!payload.ml_id) return res.status(400).json({ error: 'ml_id não identificado na coleta' });
    const { rows: prods } = await pool.query(
      `SELECT DISTINCT product_id FROM analise_product_ads WHERE ml_id = $1 AND COALESCE(monitorar, true) = true`,
      [payload.ml_id]);
    if (!prods.length) return res.json({ ok: true, ml_id: payload.ml_id, atualizados: 0, nota: 'ml_id não está na watchlist' });
    let lastAd = null;
    for (const { product_id } of prods) {
      const ad = await upsertAd(product_id, payload);
      await stampChecked(ad.id);
      wsHub.publish('analise_anuncio', { produto_id: product_id, anuncio: ad }).catch(() => {});
      lastAd = ad;
    }
    feedSnapshot(lastAd); // histórico é por ml_id — 1 snapshot basta
    res.json({ ok: true, ml_id: payload.ml_id, atualizados: prods.length });
  } catch (e) { console.error('[extension] POST monitoramento', e.message); res.status(500).json({ error: e.message }); }
});

// GET /extension/monitor/:mlb — histórico de preço do MLB (pro mini-gráfico no
// painel da extensão). Só leitura; devolve os últimos ~60 snapshots + a variação
// 30d já calculada. Público (a extensão é externa), read-only, sem dado sensível.
router.get('/monitor/:mlb', async (req, res) => {
  try {
    const mlb = String(req.params.mlb || '').match(/MLB\d+/i)?.[0];
    if (!mlb) return res.json({ historico: [], delta30d: null });
    const { rows } = await pool.query(
      `SELECT snap_date, preco FROM analise_monitor_snapshots
        WHERE ml_id = $1 AND preco IS NOT NULL
        ORDER BY snap_date DESC LIMIT 60`, [mlb]);
    const hist = rows.reverse(); // cronológico
    let delta30d = null;
    if (hist.length >= 2) {
      const hoje = Number(hist[hist.length - 1].preco);
      // 1º snapshot com >= 30 dias de diferença (ou o mais antigo que temos)
      const alvo = hist.find((h) => (Date.now() - new Date(h.snap_date)) >= 30 * 86400000) || hist[0];
      const base = Number(alvo.preco);
      if (base > 0) delta30d = Number((((hoje - base) / base) * 100).toFixed(1));
    }
    res.json({ historico: hist, delta30d, count: hist.length });
  } catch (e) { console.error('[extension] monitor', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
