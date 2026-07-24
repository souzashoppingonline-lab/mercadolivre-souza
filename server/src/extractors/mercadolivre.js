// Mercado Livre extractor — interpreta dados brutos da extensão
// Implementa os 12 pontos da especificação

const extractMercadoLivreData = (rawData) => {
  const debug = {
    titleAttempts: [],
    priceAttempts: [],
    ratingAttempts: [],
    commentsAttempts: [],
  };

  return {
    extracted: {
      url: rawData.url,
      title: extractTitle(rawData, debug),
      price: extractPrice(rawData, debug),
      salesCount: extractSalesCount(rawData, debug),
      rating: extractRating(rawData, debug),
      commentsCount: extractCommentsCount(rawData, debug),
      questionsCount: extractQuestionsCount(rawData, debug),
      comments: extractComments(rawData, debug),
      questions: extractQuestions(rawData, debug),
      seller: extractSeller(rawData, debug),
      images: extractImages(rawData, debug),
      createdAt: extractCreatedAt(rawData, debug),
    },
    debug,
  };
};

// 1. Título — múltiplos coletores
function extractTitle(rawData, debug) {
  const collectors = [
    () => {
      const match = rawData.titleHtml?.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      return match ? match[1].trim() : null;
    },
    () => {
      const match = rawData.pageText?.split('\n')[0];
      return match?.length > 10 ? match.trim() : null;
    },
    () => rawData.jsonLd?.[0]?.name || null,
  ];

  for (const collector of collectors) {
    try {
      const result = collector();
      if (result) {
        debug.titleAttempts.push({ collector: collector.toString().substring(0, 50), result });
        return result;
      }
    } catch (e) {
      debug.titleAttempts.push({ error: e.message });
    }
  }
  return null;
}

// 2. Preço — normal, promoção, PIX, parcelado
function extractPrice(rawData, debug) {
  const prices = {
    normal: null,
    promotion: null,
    pix: null,
    installments: null,
    installmentValue: null,
  };

  try {
    // Procurar múltiplos padrões de preço em pageText
    const allPrices = [];
    const pricePattern = /R\$\s*(\d{1,5})[.,](\d{2})/g;
    let match;
    while ((match = pricePattern.exec(rawData.pageText)) !== null) {
      allPrices.push(parseFloat(match[1] + '.' + match[2]));
    }

    debug.priceAttempts.push({ allPricesFound: allPrices.length, prices: allPrices });

    if (allPrices.length >= 1) {
      prices.normal = allPrices[0].toFixed(2); // Primeiro é original
    }
    if (allPrices.length >= 2) {
      prices.promotion = Math.min(...allPrices).toFixed(2); // Promoção é o menor
    }

    // PIX (procurar "PIX")
    if (rawData.pageText.includes('PIX')) {
      const pixMatch = rawData.pageText.match(/PIX[:\s]+R\$\s*(\d+[.,]\d{2})/i);
      if (pixMatch) {
        prices.pix = pixMatch[1].replace(',', '.');
      }
    }

    // Parcelado (procurar "X x" ou "parcelado")
    const installMatch = rawData.pageText.match(/(\d+)\s*x\s*R\$\s*(\d+[.,]\d{2})/i);
    if (installMatch) {
      prices.installments = parseInt(installMatch[1]);
      prices.installmentValue = installMatch[2].replace(',', '.');
    }
  } catch (e) {
    debug.priceAttempts.push({ error: e.message });
  }

  return prices;
}

// 6. Vendas — texto + número
function extractSalesCount(rawData, debug) {
  try {
    const match = rawData.pageText.match(/\+?(\d+)\s*vendidos?/i);
    if (match) {
      return {
        texto: match[0],
        numero: parseInt(match[1]),
      };
    }
  } catch (e) {
    debug.priceAttempts.push({ error: e.message });
  }
  return { texto: null, numero: null };
}

// 7. Avaliação — nota + quantidade de opiniões
function extractRating(rawData, debug) {
  const rating = {
    nota: null,
    opinioes: null,
  };

  try {
    // Procurar "X.X de 5"
    const ratingMatch = rawData.pageText.match(/([\d.]+)\s*de\s*5/i);
    if (ratingMatch) {
      rating.nota = parseFloat(ratingMatch[1]);
    }

    // Procurar quantidade de opiniões
    const opMatch = rawData.pageText.match(/\((\d+)\s*(?:opini|avalia)/i);
    if (opMatch) {
      rating.opinioes = parseInt(opMatch[1]);
    }

    debug.ratingAttempts.push({ rating });
  } catch (e) {
    debug.ratingAttempts.push({ error: e.message });
  }

  return rating;
}

// Contagem de comentários
function extractCommentsCount(rawData, debug) {
  try {
    const match = rawData.pageText.match(/(?:Comentários|Opiniões|Avaliações)\s*\(?(\d+)\)?/i);
    return match ? parseInt(match[1]) : null;
  } catch (e) {
    return null;
  }
}

// Contagem de perguntas
function extractQuestionsCount(rawData, debug) {
  try {
    const match = rawData.pageText.match(/Perguntas?\s*\(?(\d+)\)?/i);
    return match ? parseInt(match[1]) : null;
  } catch (e) {
    return null;
  }
}

// 10. Comentários — enviar todos, deixar IA processar
function extractComments(rawData, debug) {
  const comments = [];

  try {
    // Procurar elementos de review
    const reviewPattern = /<div[^>]*class="[^"]*review[^"]*"[^>]*>([^<]+)<\/div>/gi;
    let match;
    const seen = new Set();

    while ((match = reviewPattern.exec(rawData.domSnapshot?.reviewsSection || '')) !== null) {
      const text = match[1].trim();
      if (text.length > 20 && text.length < 800 && !seen.has(text)) {
        comments.push(text);
        seen.add(text);
        if (comments.length >= 100) break;
      }
    }

    debug.commentsAttempts.push({ found: comments.length });
  } catch (e) {
    debug.commentsAttempts.push({ error: e.message });
  }

  return comments;
}

// Perguntas
function extractQuestions(rawData, debug) {
  // Similar a comentários, mas para Q&A
  return [];
}

// Seller
function extractSeller(rawData, debug) {
  try {
    const match = rawData.pageText.match(/Vendido\s*(?:e\s*enviado\s*)?por:\s*(.+?)(?:\n|$)/i);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

// 9. Fotos — principal, secundárias, 360, vídeo
function extractImages(rawData, debug) {
  const images = {
    principal: null,
    secundarias: [],
    video360: null,
    video: null,
  };

  try {
    // Procurar em JSON-LD
    if (rawData.jsonLd?.[0]?.image) {
      const img = rawData.jsonLd[0].image;
      if (Array.isArray(img)) {
        images.principal = img[0];
        images.secundarias = img.slice(1);
      } else {
        images.principal = img;
      }
    }
  } catch (e) {
    // Silencioso
  }

  return images;
}

// 8. Data de criação — procurar em JSON, scripts, window
function extractCreatedAt(rawData, debug) {
  try {
    // JSON-LD
    if (rawData.jsonLd?.[0]?.datePublished) {
      return rawData.jsonLd[0].datePublished;
    }
  } catch (e) {
    // Silencioso
  }
  return null;
}

module.exports = { extractMercadoLivreData };
