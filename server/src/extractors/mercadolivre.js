// Mercado Livre extractor — interpreta dados brutos da extensão
// Implementa os 12 pontos da especificação

// Converte preço em número (ou null). Aceita "45.90" (JSON-LD, ponto decimal) e
// "1.234,56"/"45,90" (formato BR, vírgula decimal + ponto de milhar).
const toNum = (v) => {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Acha o nó "Product" no JSON-LD (fonte confiável que o ML embute na página).
function getProductNode(jsonLd) {
  if (!Array.isArray(jsonLd)) return null;
  const typesOf = (n) => [].concat((n && n['@type']) || []).map(String);
  return jsonLd.find((n) => n && (n.offers || typesOf(n).includes('Product'))) || jsonLd[0] || null;
}

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

// 1. Título — JSON-LD primeiro (confiável), depois <h1>, depois texto.
function extractTitle(rawData, debug) {
  const node = getProductNode(rawData.jsonLd);
  // Linhas de navegação/acessibilidade que NÃO são o título do anúncio.
  const skip = /pular para|ir para o conte|conteúdo principal|menu|entrar|cadastr|frete gr[aá]tis|mercado livre/i;
  const collectors = [
    () => (node && node.name) || null,
    () => {
      const match = rawData.titleHtml?.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      return match ? match[1].trim() : null;
    },
    () => {
      const line = (rawData.pageText || '').split('\n')
        .map((s) => s.trim())
        .find((s) => s.length > 10 && !skip.test(s));
      return line || null;
    },
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
    // 1) Fonte CONFIÁVEL: JSON-LD que o ML embute (offers.price). É o preço real
    //    do anúncio — evita pegar valor de parcela/frete do texto.
    const node = getProductNode(rawData.jsonLd);
    const offer = Array.isArray(node && node.offers) ? node.offers[0] : (node && node.offers);
    if (offer) {
      const jlNormal = toNum(offer.price != null ? offer.price : offer.highPrice);
      const jlLow = toNum(offer.lowPrice);
      if (jlNormal != null) prices.normal = jlNormal.toFixed(2);
      if (jlLow != null && jlNormal != null && jlLow < jlNormal) prices.promotion = jlLow.toFixed(2);
      debug.priceAttempts.push({ source: 'jsonLd', price: prices.normal, promotion: prices.promotion });
    }

    // 2) Fallback: varre o texto, mas remove antes os valores de PARCELA
    //    ("12x R$ 2,45" / "12x de R$ 2,45") pra não confundir com o preço.
    if (prices.normal == null) {
      const cleanText = String(rawData.pageText || '')
        .replace(/\d+\s*x\s*(de\s*)?R\$\s*\d{1,3}(?:[.,]\d{2})?/gi, ' ');
      const allPrices = [];
      const pricePattern = /R\$\s*(\d{1,3}(?:\.\d{3})*|\d{1,5})[.,](\d{2})/g;
      let match;
      while ((match = pricePattern.exec(cleanText)) !== null) {
        allPrices.push(toNum(match[1] + ',' + match[2]));
      }
      const valid = allPrices.filter((n) => n != null);
      debug.priceAttempts.push({ source: 'pageText', allPricesFound: valid.length, prices: valid });
      if (valid.length >= 1) prices.normal = valid[0].toFixed(2);
      if (valid.length >= 2) prices.promotion = Math.min(...valid).toFixed(2);
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
    // 1) JSON-LD aggregateRating (confiável)
    const agg = getProductNode(rawData.jsonLd)?.aggregateRating;
    if (agg) {
      if (agg.ratingValue != null) rating.nota = toNum(agg.ratingValue);
      const cnt = agg.reviewCount != null ? agg.reviewCount : agg.ratingCount;
      if (cnt != null) rating.opinioes = parseInt(cnt, 10);
    }

    // 2) Fallback pelo texto ("X.X de 5" / "(N opiniões)")
    if (rating.nota == null) {
      const ratingMatch = rawData.pageText.match(/([\d.]+)\s*de\s*5/i);
      if (ratingMatch) rating.nota = parseFloat(ratingMatch[1]);
    }
    if (rating.opinioes == null) {
      const opMatch = rawData.pageText.match(/\((\d+)\s*(?:opini|avalia)/i);
      if (opMatch) rating.opinioes = parseInt(opMatch[1]);
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
