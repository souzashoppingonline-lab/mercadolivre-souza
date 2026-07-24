// Content script for extracting Mercado Livre product data
// Runs in the context of mercadolivre.com.br pages

console.log('FinanceEcom Monitor content script loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectData') {
    const data = extractMercadoLivreData();
    sendResponse(data);
  }
});

function extractMercadoLivreData() {
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

    // Extract title (multiple possible selectors for ML pages)
    const titleEl = document.querySelector('h1') ||
                    document.querySelector('h2') ||
                    document.querySelector('[class*="title"]');
    if (titleEl) {
      data.title = titleEl.textContent.trim();
    }

    // Extract price
    const priceEl = document.querySelector('[class*="price"]') ||
                    document.querySelector('[data-price]') ||
                    document.querySelector('.price-tag');
    if (priceEl) {
      const priceText = priceEl.textContent.trim();
      // Clean price to extract numbers
      const priceMatch = priceText.match(/R\$?\s*([\d.,]+)/);
      if (priceMatch) {
        data.price = priceMatch[1].replace(',', '.');
      }
    }

    // Extract sales count (look for "XXX vendas" pattern)
    const pageText = document.body.innerText;
    const salesMatch = pageText.match(/(\d+)\s*vendas?\s*(?:no|em|last)?/i);
    if (salesMatch) {
      data.salesCount = parseInt(salesMatch[1], 10);
    }

    // Extract rating and rating count
    const ratingEl = document.querySelector('[class*="rating"]') ||
                     document.querySelector('[data-rating]') ||
                     document.querySelector('[class*="star"]');
    if (ratingEl) {
      const ratingText = ratingEl.textContent.trim();
      const ratingMatch = ratingText.match(/([\d.]+)/);
      if (ratingMatch) {
        data.rating = parseFloat(ratingMatch[1]);
      }

      // Look for rating count
      const ratingCountMatch = ratingText.match(/(\d+)\s*(?:avalia|opini|review)/i);
      if (ratingCountMatch) {
        data.ratingCount = parseInt(ratingCountMatch[1], 10);
      }
    }

    // Extract seller name
    const sellerEl = document.querySelector('[class*="seller"]') ||
                     document.querySelector('[class*="vendor"]');
    if (sellerEl) {
      data.seller = sellerEl.textContent.trim();
    }

    // Extract comments/reviews
    const commentEls = document.querySelectorAll('[class*="review"]') ||
                      document.querySelectorAll('[class*="comment"]');

    if (commentEls && commentEls.length > 0) {
      data.commentsCount = commentEls.length;

      // Extract comment texts
      Array.from(commentEls).slice(0, 10).forEach((el) => {
        const text = el.textContent.trim();
        if (text.length > 0 && text.length < 1000) {
          data.comments.push(text.substring(0, 500));
        }
      });
    } else {
      // Fallback: look for review sections
      const reviewSections = document.querySelectorAll('[class*="opinion"]');
      if (reviewSections && reviewSections.length > 0) {
        data.commentsCount = reviewSections.length;
      }
    }

    // Extract questions
    const questionEls = document.querySelectorAll('[class*="question"]') ||
                       document.querySelectorAll('[class*="qa"]') ||
                       document.querySelectorAll('[class*="faq"]');

    if (questionEls && questionEls.length > 0) {
      data.questionsCount = questionEls.length;

      // Extract question texts
      Array.from(questionEls).slice(0, 5).forEach((el) => {
        const text = el.textContent.trim();
        if (text.length > 0 && text.length < 500) {
          data.questions.push(text);
        }
      });
    }

  } catch (error) {
    console.error('Erro ao extrair dados do Mercado Livre:', error);
  }

  return data;
}
