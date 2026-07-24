// Rota pública para Chrome Extension coletar dados de anúncios
// Não requer autenticação — é uma endpoint aberta para a extensão enviar dados
const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { marketplace, pageUrl, title, price, salesCount, rating, commentsCount, questionsCount, comments, collectedAt } = req.body;

    if (!marketplace || !pageUrl) {
      return res.status(400).json({ error: 'marketplace e pageUrl são obrigatórios' });
    }

    console.log('[extension/collect] Dados coletados:', {
      marketplace,
      pageUrl,
      title: title ? title.substring(0, 50) : null,
      salesCount,
      commentsCount,
      questionsCount,
      collectedAt
    });

    res.json({
      success: true,
      message: 'Dados recebidos e processados',
      received: {
        marketplace,
        pageUrl,
        title,
        price,
        salesCount,
        rating,
        commentsCount,
        questionsCount,
        collectedAt
      }
    });
  } catch (error) {
    console.error('[extension/collect] Erro ao processar coleta:', error.message);
    res.status(500).json({ error: 'Erro ao processar dados', details: error.message });
  }
});

module.exports = router;
