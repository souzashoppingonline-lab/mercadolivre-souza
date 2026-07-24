// Content script v2 — coleta dados BRUTOS, deixa backend processar
console.log('FinanceEcom Monitor v2 - coleta de dados brutos');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectData') {
    const rawData = collectRawData();
    sendResponse(rawData);
  }
});

function collectRawData() {
  return {
    url: window.location.href,
    pageText: document.body.innerText,

    // HTML de seções-chave (evita HTML gigante)
    titleHtml: document.querySelector('h1')?.outerHTML || null,
    priceHtml: document.querySelector('[class*="price"]')?.outerHTML || null,
    ratingHtml: document.querySelector('[class*="rating"], [class*="stars"]')?.outerHTML || null,

    // JSON-LD (estruturado)
    jsonLd: extractJsonLd(),

    // Snapshot do DOM (estrutura, não texto gigante)
    domSnapshot: captureDomStructure(),

    // Timestamp
    collectedAt: new Date().toISOString(),
  };
}

function extractJsonLd() {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  return scripts
    .map(s => {
      try {
        return JSON.parse(s.textContent);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function captureDomStructure() {
  // Mapear estrutura HTML sem copiar texto gigante
  return {
    priceSection: document.querySelector('[class*="price"]')?.innerHTML?.substring(0, 2000) || null,
    ratingSection: document.querySelector('[class*="rating"]')?.innerHTML?.substring(0, 1000) || null,
    reviewsSection: document.querySelector('[class*="review"], [class*="opinion"]')?.innerHTML?.substring(0, 2000) || null,
  };
}
