// Rota pública para Chrome Extension coletar dados brutos de anúncios
// Extensão envia dados BRUTOS → backend processa e extrai
const express = require('express');
const router = express.Router();
const { extractMercadoLivreData } = require('../extractors/mercadolivre');

router.post('/', async (req, res) => {
  try {
    const { marketplace, rawData, collectedAt } = req.body;

    if (!marketplace || !rawData) {
      return res.status(400).json({ error: 'marketplace e rawData são obrigatórios' });
    }

    console.log('[extension/collect] Dados brutos recebidos de', marketplace);

    // Processar dados BRUTOS com o extractor
    let extracted, debug;
    if (marketplace === 'mercadolivre') {
      const result = extractMercadoLivreData(rawData);
      extracted = result.extracted;
      debug = result.debug;
    } else {
      return res.status(400).json({ error: `Marketplace ${marketplace} não suportado ainda` });
    }

    // TODO: persistir em banco de dados
    console.log('[extension/collect] Dados extraídos:', {
      title: extracted.title ? extracted.title.substring(0, 50) : null,
      price: extracted.price?.promotion || extracted.price?.normal,
      salesCount: extracted.salesCount?.numero,
      rating: extracted.rating?.nota,
      commentsCount: extracted.commentsCount,
      questionsCount: extracted.questionsCount,
    });

    res.json({
      success: true,
      message: 'Dados extraídos com sucesso',
      extracted,
      debug,
    });
  } catch (error) {
    console.error('[extension/collect] Erro ao processar coleta:', error.message);
    res.status(500).json({ error: 'Erro ao processar dados', details: error.message });
  }
});

module.exports = router;
