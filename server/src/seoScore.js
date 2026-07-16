// Engine do SEO Score — Qualidade de Anúncio. NUNCA usa IA pra calcular, só
// fórmula determinística (pedido explícito do usuário). A IA (se um dia
// existir aqui) só pode interpretar o resultado já calculado, nunca gerar
// o número. Ver .claude/decisions.md.
//
// Pesos normalizados a partir da especificação original do usuário — os
// pesos pedidos (fotos 15, vídeo 10, título 15, descrição 10, GTIN 5, marca 5,
// modelo 5, FULL 8, catálogo 10, atributos 12, conversão 15, visitas 5)
// somavam 115, não 100. Normalizado proporcionalmente (× 100/115, 2 casas)
// pra manter a importância relativa entre os critérios que o usuário definiu.
const WEIGHTS = {
  photos: 13.04,
  video: 8.70,
  title: 13.04,
  description: 8.70,
  gtin: 4.35,
  brand: 4.35,
  model: 4.35,
  full: 6.96,
  catalog: 8.70,
  attributes: 10.43,
  conversion: 13.04,
  visits: 4.35,
};
// Soma real: 100.01 (arredondamento de 2 casas em 12 valores) — negligível.

// Limiares "nota máxima a partir de" — ajustáveis, não são regra oficial do
// ML, exceto titleMaxChars (limite real de caracteres de título no MLB).
// Se a operação mostrar que esses valores não fazem sentido na prática,
// ajustar aqui não exige mudar nada mais no sistema.
const THRESHOLDS = {
  photosForFullScore: 6,         // ML recomenda 6+ fotos
  titleMaxChars: 60,             // limite real de título no MLB
  descriptionWordsForFullScore: 200,
  conversionForFullScore: 0.05,  // 5% pedidos/visitas em 30 dias
  visitsForFullScore: 500,       // visitas/30 dias
};

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

// signals: sinais já extraídos do item (dado oficial da API) — esta função
// não faz I/O nenhum, só calcula. Devolve os subscores (métrica calculada
// pelo sistema) e o total — nunca sobrescreve os sinais de entrada.
function computeSeoScore(signals) {
  const {
    picturesCount = 0,
    hasVideo = false,
    titleLength = 0,
    descriptionWordCount = 0,
    hasGtin = false,
    hasBrand = false,
    hasModel = false,
    isFull = false,
    catalogListing = false,
    requiredAttrsTotal = 0,
    requiredAttrsMissing = 0,
    conversionRate = 0,
    visits30d = 0,
  } = signals;

  // Categoria sem nenhum atributo obrigatório: não penaliza (não é culpa do anúncio).
  const attrsCompleteness = requiredAttrsTotal > 0
    ? clamp01((requiredAttrsTotal - requiredAttrsMissing) / requiredAttrsTotal)
    : 1;

  const subscores = {
    photos: round2(clamp01(picturesCount / THRESHOLDS.photosForFullScore) * WEIGHTS.photos),
    video: hasVideo ? WEIGHTS.video : 0,
    title: round2(clamp01(titleLength / THRESHOLDS.titleMaxChars) * WEIGHTS.title),
    description: round2(clamp01(descriptionWordCount / THRESHOLDS.descriptionWordsForFullScore) * WEIGHTS.description),
    gtin: hasGtin ? WEIGHTS.gtin : 0,
    brand: hasBrand ? WEIGHTS.brand : 0,
    model: hasModel ? WEIGHTS.model : 0,
    full: isFull ? WEIGHTS.full : 0,
    catalog: catalogListing ? WEIGHTS.catalog : 0,
    attributes: round2(attrsCompleteness * WEIGHTS.attributes),
    conversion: round2(clamp01(conversionRate / THRESHOLDS.conversionForFullScore) * WEIGHTS.conversion),
    visits: round2(clamp01(visits30d / THRESHOLDS.visitsForFullScore) * WEIGHTS.visits),
  };

  const total = round2(Object.values(subscores).reduce((a, b) => a + b, 0));

  return { subscores, total };
}

module.exports = { computeSeoScore, WEIGHTS, THRESHOLDS };
