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

    // Get page text for regex matching
    const pageText = document.body.innerText;

    // Extract price — padrão rigoroso: "R$ XXX,XX" (até 5 dígitos inteiros, 2 decimais)
    const priceMatch = pageText.match(/R\$\s*(\d{1,5})[.,](\d{2})\b/);
    if (priceMatch) {
      const intPart = priceMatch[1];
      const decPart = priceMatch[2];
      data.price = intPart + '.' + decPart;
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

    // Se há botão "Mostrar todas as opiniões", tentar clicar e extrair mais
    if (data.commentsCount > data.comments.length) {
      await collectAllComments(data);
    }

  } catch (error) {
    console.error('Erro ao extrair dados do Mercado Livre:', error);
  }

  return data;
}

function extractCommentsFromPage() {
  const comments = [];
  const seen = new Set();

  // Padrões de texto que indicam metadata/não-comentário
  const excludePatterns = [
    /^[\d.,\s★]*$/,  // Só números/pontos/vírgulas/estrelas
    /^[\d.]+\s*de\s*5/i,  // "4.8 de 5"
    /mostrar todas|ver todas|opiniões/i,
    /avaliação.*de\s*5/i,
    /novo|vendidos|+\d+/i,
    /informações|carregando|mais vendido/i,
    /em suportes|adicionar aos favoritos/i,
    /^[\d.]+\s*avaliação/i,
    /frete|garantia|devolução|compre|produto original/i,
    /^[a-z0-9.]+$/i,  // Strings genéricas muito curtas
  ];

  // Estratégia 1: Procurar por elementos com classe review/opinion/comment
  const reviewElements = document.querySelectorAll(
    '[class*="review"], [class*="opinion"], [class*="comment"], [class*="feedback"]'
  );

  if (reviewElements.length > 0) {
    reviewElements.forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length > 20 && text.length < 800 && !seen.has(text)) {
        let isExcluded = excludePatterns.some(p => p.test(text));
        if (!isExcluded) {
          comments.push(text);
          seen.add(text);
        }
      }
    });
  }

  // Estratégia 2: Se poucos comentários, usar TreeWalker como fallback
  if (comments.length < 20) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT_NODE,
      null,
      false
    );

    let node;
    while (node = walker.nextNode() && comments.length < 100) {
      const text = node.textContent.trim();

      if (text.length > 30 && text.length < 800 && !seen.has(text)) {
        let isExcluded = excludePatterns.some(p => p.test(text));
        if (!isExcluded) {
          comments.push(text);
          seen.add(text);
        }
      }
    }
  }

  return comments;
}

async function collectAllComments(data) {
  try {
    // Procurar botão "Mostrar todas as opiniões" ou similar
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const showAllBtn = buttons.find(btn => {
      const text = btn.textContent.toLowerCase();
      return text.includes('mostrar todas') || text.includes('ver todas') || text.includes('opiniões');
    });

    if (showAllBtn) {
      console.log('[extension] Clicando em "Mostrar todas as opiniões"...');
      showAllBtn.click();

      // Aguardar modal abrir (max 3s)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Procurar comentários no modal
      const modalComments = extractCommentsFromPage();
      const newComments = modalComments.filter(c => !data.comments.includes(c));

      if (newComments.length > 0) {
        data.comments.push(...newComments.slice(0, 100 - data.comments.length));
        console.log('[extension] Adicionados', newComments.length, 'comentários do modal');
      }

      // Fechar modal (procurar X ou ESC)
      const closeBtn = document.querySelector('[aria-label*="close" i], button[class*="close" i]');
      if (closeBtn) closeBtn.click();
    }
  } catch (err) {
    console.error('[extension] Erro ao abrir modal de comentários:', err.message);
  }
}
