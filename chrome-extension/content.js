// Content script for extracting Mercado Livre product data
// Runs in the context of mercadolivre.com.br pages

console.log('FinanceEcom Monitor content script loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectData') {
    extractMercadoLivreData().then(data => sendResponse(data));
  }
});

async function extractMercadoLivreData() {
  const data = {
    title: null,
    price: null,
    salesCount: null,
    rating: null,
    ratingCount: null,
    commentsCount: null,
    questionsCount: null,
    comments: [],
    questions: [],
    seller: null,
    sellerId: null,
    productId: null,
  };

  try {
    // Extract product ID from URL
    const urlMatch = window.location.pathname.match(/MLB(\d+)/);
    if (urlMatch) {
      data.productId = urlMatch[1];
    }

    // Extract title — ML geralmente em h1
    const titleEl = document.querySelector('h1');
    if (titleEl) {
      data.title = titleEl.textContent.trim();
    }

    // Extract price — buscar por texto "R$" com número (pegar apenas o primeiro)
    const pageText = document.body.innerText;
    const priceMatch = pageText.match(/R\$\s*([\d.]+[.,]\d{2})/);
    if (priceMatch) {
      // Normalizar: remover pontos de milhar, manter virgula decimal
      let price = priceMatch[1];
      price = price.replace(/\./g, '').replace(',', '.');
      // Se tiver mais de um ponto, é erro — tomar só os primeiros dígitos
      data.price = price;
    }

    // Extract sales count — padrão "XXX vendas"
    const salesMatch = pageText.match(/^(\d+)\s*vendas?$/m);
    if (salesMatch) {
      data.salesCount = parseInt(salesMatch[1], 10);
    } else {
      const salesFallback = pageText.match(/(\d+)\s*vendas/i);
      if (salesFallback) {
        data.salesCount = parseInt(salesFallback[1], 10);
      }
    }

    // Extract rating — buscar "X.X de 5" ou "★★★★★ X.X"
    const ratingMatch = pageText.match(/([\d.]+)\s*(?:de\s*5|★)/);
    if (ratingMatch) {
      const ratingVal = parseFloat(ratingMatch[1]);
      if (ratingVal >= 0 && ratingVal <= 5) {
        data.rating = ratingVal;
      }
    }

    // Extract rating count — "(XXXX)"
    const ratingCountMatch = pageText.match(/\((\d+)\s*(?:opini|avalia|review)\)/i);
    if (ratingCountMatch) {
      data.ratingCount = parseInt(ratingCountMatch[1], 10);
    }

    // Extract comments count
    const commentsHeaderMatch = pageText.match(/(?:Comentários|Opiniões)\s*(?:\()?(\d+)\)?/i);
    if (commentsHeaderMatch) {
      data.commentsCount = parseInt(commentsHeaderMatch[1], 10);
    }

    // Extract questions count
    const questionsHeaderMatch = pageText.match(/Perguntas?\s*(?:\()?(\d+)\)?/i);
    if (questionsHeaderMatch) {
      data.questionsCount = parseInt(questionsHeaderMatch[1], 10);
    }

    // Extract seller name
    const sellerMatch = pageText.match(/Vendido\s*(?:e\s*enviado\s*)?por:\s*(.+?)(?:\n|$)/i);
    if (sellerMatch) {
      data.seller = sellerMatch[1].trim();
    }

    // Extract comments — inicialmente os visíveis
    const visibleComments = extractCommentsFromPage();
    data.comments.push(...visibleComments.slice(0, 100));

    // Se há botão "Mostrar todas as opiniões", clicar e extrair mais
    if (data.comments.length < 100 && data.commentsCount > data.comments.length) {
      await collectAllComments(data);
    }

  } catch (error) {
    console.error('Erro ao extrair dados do Mercado Livre:', error);
  }

  return data;
}

function extractCommentsFromPage() {
  const comments = [];

  // Procurar por divs que contêm comentários/opiniões
  const possibleSelectors = [
    '[class*="review-content"]',
    '[class*="comment-text"]',
    '[class*="opinion-text"]',
    '[class*="user-review"]'
  ];

  // Também buscar por padrão de texto que começa com comentário real
  const allElements = document.querySelectorAll('div, p, span');

  Array.from(allElements).forEach((el) => {
    const text = el.textContent.trim();

    // Filtrar: comentário deve ter entre 15-1000 caracteres
    // NÃO deve conter padrões de avaliação/metadata
    if (text.length > 15 && text.length < 1000) {
      const lowerText = text.toLowerCase();

      // Descartar se for metadata/avaliação
      if (
        lowerText.includes('mostrar todas') ||
        lowerText.includes('avaliação') ||
        lowerText.includes('informações avantpro') ||
        lowerText.includes('carregando dados') ||
        text.match(/^\d+\s*$/) || // Só números
        text.match(/^[\d.]+\s*de\s*5/) // Padrão de rating
      ) {
        return;
      }

      // Se passou nos filtros, é um comentário
      if (!comments.includes(text)) {
        comments.push(text);
      }
    }
  });

  return comments;
}

async function collectAllComments(data) {
  try {
    // Procurar botão "Mostrar todas as opiniões"
    const button = Array.from(document.querySelectorAll('a, button')).find(el =>
      el.textContent.toLowerCase().includes('mostrar todas') &&
      el.textContent.toLowerCase().includes('opini')
    );

    if (button) {
      console.log('[extension] Clicando em "Mostrar todas as opiniões"...');
      button.click();

      // Aguardar modal carregar (3 segundos)
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Extrair comentários do modal
      const modalComments = extractCommentsFromPage();

      // Adicionar comentários até atingir 100
      for (const comment of modalComments) {
        if (data.comments.length >= 100) break;
        if (!data.comments.includes(comment)) {
          data.comments.push(comment);
        }
      }

      console.log(`[extension] Total de comentários coletados: ${data.comments.length}`);

      // Fechar modal (ESC ou clique em X)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  } catch (error) {
    console.error('[extension] Erro ao coletar comentários adicionais:', error);
  }
}
