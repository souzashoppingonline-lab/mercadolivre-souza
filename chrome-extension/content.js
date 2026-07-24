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

    // Extract price — RIGOROSO: pegar primeira ocorrência de R$ seguida de número com até 5 dígitos inteiros
    const pageText = document.body.innerText;
    // Padrão: R$ + 1-5 dígitos + separador + 2 dígitos (ex: R$ 129,90 ou R$ 1.234,56)
    const priceMatch = pageText.match(/R\$\s*(\d{1,5}(?:[.,]\d{3})*[.,]\d{2})/);
    if (priceMatch) {
      let price = priceMatch[1];
      // Normalizar: remover TODOS os pontos (milhar), depois converter última vírgula em ponto
      price = price.replace(/\./g, '').replace(',', '.');
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
  const seen = new Set();

  // Padrões de texto que indicam metadata/não-comentário
  const excludePatterns = [
    /^[\d.,\s]*$/,  // Só números/pontos/vírgulas
    /mostrar todas/i,
    /avaliação.*de\s*5/i,
    /opini[õo]es/i,
    /novo.*vendidos/i,
    /\+\d+\s*vendidos/i,
    /informações/i,
    /carregando dados/i,
    /mais vendido/i,
    /em suportes/i,
    /adicionar aos favoritos/i,
    /bcom/i,
    /^[\d.]+\s*avaliação/i
  ];

  // Procurar por todos os textos na página
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT_NODE,
    null,
    false
  );

  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();

    // Verificar se é um comentário válido
    if (text.length > 20 && text.length < 800) {
      let isExcluded = false;

      // Verificar se corresponde a algum padrão de exclusão
      for (const pattern of excludePatterns) {
        if (pattern.test(text)) {
          isExcluded = true;
          break;
        }
      }

      // Se passou, adicionar
      if (!isExcluded && !seen.has(text)) {
        comments.push(text);
        seen.add(text);

        // Limitar a 100
        if (comments.length >= 100) break;
      }
    }
  }

  return comments;
}

async function collectAllComments(data) {
  // Por enquanto, desabilitado — o modal de ML é complexo de automatizar
  // Os comentários visíveis já são suficientes para análise
  console.log('[extension] Coleta de comentários visíveis concluída:', data.comments.length);
}
