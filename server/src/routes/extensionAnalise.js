// Análise de Produtos — rotas PÚBLICAS consumidas pela extensão Chrome.
// Montadas antes do gate de staff (a extensão é externa). A extensão NUNCA
// pergunta pra qual produto enviar: lê o produto ativo daqui. Ver .claude/analise-produtos.md.
const express = require('express');
const pool = require('../db/pool');
const wsHub = require('../ws/hub');
const { num, upsertAd } = require('../analise/ads');
const { extractMercadoLivreData } = require('../extractors/mercadolivre');

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
      payload = {
        ml_id: m ? ('MLB' + m[1]) : null,
        titulo: extracted.title || null,
        preco, preco_original,
        nota: extracted.rating && extracted.rating.nota != null ? extracted.rating.nota : null,
        vendas: extracted.salesCount && extracted.salesCount.texto ? extracted.salesCount.texto : null,
        perguntas: extracted.questionsCount != null ? extracted.questionsCount : null,
        comentarios: extracted.commentsCount != null ? extracted.commentsCount
                     : (extracted.rating && extracted.rating.opinioes != null ? extracted.rating.opinioes : null),
        vendedor: extracted.seller || null,
        comentarios_auto: extracted.commentsText || null,
        fotos,
        raw: b.rawData,
      };
    } else {
      payload = b; // campos já prontos
    }
    const ad = await upsertAd(pid, payload);
    wsHub.publish('analise_anuncio', { produto_id: pid, anuncio: ad }).catch(() => {});
    res.json({ ok: true, produto_id: pid, anuncio: ad });
  } catch (e) { console.error('[extension] POST anuncio', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
