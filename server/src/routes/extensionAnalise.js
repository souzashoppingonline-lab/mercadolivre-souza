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

// POST /extension/anuncio — grava o anúncio coletado no produto ATIVO.
// Aceita `rawData` (HTML/texto da página → o servidor extrai) ou campos já prontos.
router.post('/anuncio', async (req, res) => {
  try {
    const { rows: acr } = await pool.query(`SELECT product_id FROM analise_active_collection WHERE id=1`);
    const pid = acr[0]?.product_id;
    if (!pid) return res.status(409).json({ error: 'nenhum produto ativo — ative a coleta no dashboard' });

    const b = req.body || {};
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
    const ad = await upsertAd(pid, payload);
    // Alimenta o histórico de monitoramento com o preço lido da PÁGINA (fonte que
    // funciona — o ML bloqueia a leitura do item de concorrente via API/403).
    if (ad.ml_id && ad.preco != null) {
      require('../analise/monitor').recordSnapshot(ad.ml_id, { preco: ad.preco, preco_original: ad.preco_original }).catch(() => {});
    }
    wsHub.publish('analise_anuncio', { produto_id: pid, anuncio: ad }).catch(() => {});
    res.json({ ok: true, produto_id: pid, anuncio: ad });
  } catch (e) { console.error('[extension] POST anuncio', e.message); res.status(500).json({ error: e.message }); }
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
