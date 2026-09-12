// Motor de precificação Shopee — regra de negócio centralizada, sem nenhuma
// dependência de banco/HTTP (fácil de testar isoladamente, ver
// server/test/shopeePricing.test.js). Consumido por routes/shopee.js
// (rotas /precificador e /precificador/simular). Ver .claude/shopee.md.
//
// ORIGEM DA TABELA: fornecida pelo usuário ("comissão para vendedores CNPJ").
// Faixas por VALOR DO ITEM (preço de venda, depois de qualquer desconto —
// ver nota em calculateShopeePricing sobre essa premissa).
//
// SUBSÍDIO PIX (`pixSubsidy`): exposto em cada faixa só pra EXIBIÇÃO (tabela
// oficial na tela) — pedido explícito do usuário pra NUNCA entrar no cálculo
// de comissão/lucro/margem/preço ideal, porque não dá pra saber de antemão
// se o comprador vai pagar via Pix. Nenhuma função deste arquivo soma esse
// valor a nada — se algum dia a regra mudar, é só reintroduzir o termo nas
// 3 funções que fazem a conta (calculateShopeePricing, netProfitCentsForPrice,
// findIdealPrice), buscando por "pixSubsidy" nelas.
const SHOPEE_PRICING_TIERS = Object.freeze([
  { minPrice: 0,      maxPrice: 79.99,  commissionRate: 20, fixedFee: 4,  pixSubsidy: 0 },
  { minPrice: 80,     maxPrice: 99.99,  commissionRate: 14, fixedFee: 16, pixSubsidy: 5 },
  { minPrice: 100,    maxPrice: 199.99, commissionRate: 14, fixedFee: 20, pixSubsidy: 5 },
  { minPrice: 200,    maxPrice: 499.99, commissionRate: 14, fixedFee: 26, pixSubsidy: 5 },
  { minPrice: 500,    maxPrice: Infinity, commissionRate: 14, fixedFee: 26, pixSubsidy: 8 },
]);

// Preço em centavos (inteiro) evita erro de ponto flutuante em soma/comparação
// de dinheiro (ver spec "usar precisão adequada para dinheiro"). Todo cálculo
// interno usa centavos; só a apresentação/saída volta pra reais (float).
const toCents = (v) => Math.round(Number(v || 0) * 100);
const toReais = (c) => c / 100;
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function getTierForPrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return null;
  return SHOPEE_PRICING_TIERS.find((t) => p >= t.minPrice && p <= t.maxPrice) || null;
}

// Empilhamento de descontos (promoção relâmpago + cupom loja + cupom
// produto): implementado como SEQUENCIAL/MULTIPLICATIVO (cada desconto aplica
// sobre o preço já reduzido pelo anterior), não soma simples de percentuais.
// PREMISSA NÃO CONFIRMADA COM A SHOPEE — é a forma mais comum de acumular
// cupons em e-commerce (nunca gera desconto negativo/>100% mesmo que a soma
// dos percentuais passe de 100%), mas pode divergir do motor real da Shopee.
// Deixado como função isolada pra trocar a estratégia sem tocar no resto do
// motor (ver spec seção 15 — "implementar de forma configurável").
function applyStackedDiscounts(priceCents, discountsPct) {
  return discountsPct.reduce((cents, pct) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return Math.round(cents * (1 - p / 100));
  }, priceCents);
}

// Entrada/saída conforme a especificação (seção 14). `taxRate` é o imposto
// em % (não a comissão Shopee — essa vem da faixa, não é parâmetro de entrada).
function calculateShopeePricing({
  cost,
  currentPrice,
  targetMargin = 0,
  taxRate = 0,
  flashSaleDiscount = 0,
  storeCouponDiscount = 0,
  productCouponDiscount = 0,
}) {
  const costCents = cost != null ? toCents(cost) : null;
  const priceCents = toCents(currentPrice);
  const pricingTier = getTierForPrice(toReais(priceCents));

  if (!pricingTier || priceCents <= 0) {
    return {
      currentPrice: toReais(priceCents), idealPrice: null, commissionRate: null, fixedFee: null,
      pixSubsidy: null, netRevenue: null, profit: null, margin: null, pricingTier: null,
    };
  }

  // Desconto aplicado sobre o preço anunciado — "preço após descontos" é a
  // base usada tanto pra achar a faixa de comissão quanto pra imposto (mesma
  // base de cálculo, PREMISSA documentada acima) e é o valor que o comprador
  // de fato paga (base real da comissão da Shopee).
  const afterDiscountsCents = applyStackedDiscounts(priceCents, [flashSaleDiscount, storeCouponDiscount, productCouponDiscount]);
  const tierAfterDiscount = getTierForPrice(toReais(afterDiscountsCents)) || pricingTier;

  const commissionCents = Math.round(afterDiscountsCents * (tierAfterDiscount.commissionRate / 100));
  const fixedFeeCents = toCents(tierAfterDiscount.fixedFee);
  const taxCents = Math.round(afterDiscountsCents * (Number(taxRate) || 0) / 100);
  // Subsídio Pix: pedido explícito do usuário pra NÃO entrar no cálculo —
  // nunca dá pra saber de antemão se o comprador vai pagar via Pix, então
  // contar com o subsídio inflaria o lucro/margem projetados de forma
  // otimista e não garantida. Continua exposto (tierAfterDiscount.pixSubsidy)
  // só pra exibição informativa na tela (tabela oficial + simulação),
  // marcado como "não aplicado no cálculo".

  const netRevenueCents = afterDiscountsCents - commissionCents - fixedFeeCents - taxCents;
  const profitCents = costCents != null ? netRevenueCents - costCents : null;
  const margin = profitCents != null && priceCents > 0 ? (profitCents / priceCents) * 100 : null;

  const idealPrice = costCents != null
    ? findIdealPrice({ cost: toReais(costCents), targetMargin, taxRate, flashSaleDiscount, storeCouponDiscount, productCouponDiscount })
    : null;

  return {
    currentPrice: toReais(priceCents),
    idealPrice: idealPrice?.price ?? null,
    commissionRate: tierAfterDiscount.commissionRate,
    fixedFee: tierAfterDiscount.fixedFee,
    pixSubsidy: tierAfterDiscount.pixSubsidy,
    netRevenue: round2(toReais(netRevenueCents)),
    profit: profitCents != null ? round2(toReais(profitCents)) : null,
    margin: margin != null ? round2(margin) : null,
    pricingTier: tierAfterDiscount,
  };
}

// Lucro líquido (em centavos) pra um preço anunciado (antes de descontos) e
// um custo dados — reaproveitado por findIdealPrice e pelos testes.
function netProfitCentsForPrice(priceCents, costCents, { taxRate = 0, flashSaleDiscount = 0, storeCouponDiscount = 0, productCouponDiscount = 0 } = {}) {
  const tier = getTierForPrice(toReais(priceCents));
  if (!tier) return null;
  const afterDiscountsCents = applyStackedDiscounts(priceCents, [flashSaleDiscount, storeCouponDiscount, productCouponDiscount]);
  const afterTier = getTierForPrice(toReais(afterDiscountsCents)) || tier;
  const commissionCents = Math.round(afterDiscountsCents * (afterTier.commissionRate / 100));
  const fixedFeeCents = toCents(afterTier.fixedFee);
  const taxCents = Math.round(afterDiscountsCents * (Number(taxRate) || 0) / 100);
  // Subsídio Pix propositalmente fora da conta — ver nota em calculateShopeePricing.
  return afterDiscountsCents - commissionCents - fixedFeeCents - taxCents - costCents;
}

// Menor preço que atinge a margem desejada (spec seções 13/17): pra CADA
// faixa, resolve algebricamente o preço mínimo dentro dela (fórmula fechada,
// não busca por tentativa) e verifica se esse preço cai de fato dentro da
// faixa usada pro cálculo — senão descarta (não pertence). No fim compara
// todas as soluções válidas e devolve a de menor preço. Não assume que uma
// fórmula única serve pra todas as faixas (comissão/taxa fixa mudam).
function findIdealPrice({ cost, targetMargin = 0, taxRate = 0, flashSaleDiscount = 0, storeCouponDiscount = 0, productCouponDiscount = 0 }) {
  const costCents = toCents(cost);
  if (costCents <= 0) return null;
  const margem = Math.max(0, Math.min(99.999, Number(targetMargin) || 0));
  const imposto = Math.max(0, Number(taxRate) || 0);
  const descontoTotalFrac = 1
    - (1 - Math.max(0, Math.min(100, flashSaleDiscount)) / 100)
    * (1 - Math.max(0, Math.min(100, storeCouponDiscount)) / 100)
    * (1 - Math.max(0, Math.min(100, productCouponDiscount)) / 100);
  const fatorPosDesconto = 1 - descontoTotalFrac; // preço anunciado × isso = preço após descontos

  const candidatos = [];
  for (const tier of SHOPEE_PRICING_TIERS) {
    // netRevenue = afterDiscount*(1 - comissão% - imposto%) - taxaFixa (SEM
    // subsídio Pix — pedido explícito do usuário, nunca dá pra garantir que o
    // comprador vai pagar via Pix).
    // profit = netRevenue - cost; margin = profit / preçoAnunciado (não sobre o
    // preço após desconto — margem é "lucro sobre o preço de venda anunciado",
    // conforme o texto auxiliar do card 1 da spec).
    // profit = preçoAnunciado*fatorPosDesconto*(1 - com% - imp%) - taxaFixa - cost
    // margin*preçoAnunciado = profit
    // preçoAnunciado*(fatorPosDesconto*(1-com%-imp%) - margem%) = taxaFixa + cost
    const fatorLiquido = fatorPosDesconto * (1 - tier.commissionRate / 100 - imposto / 100);
    const denom = fatorLiquido - margem / 100;
    if (denom <= 0) continue; // margem desejada inatingível nessa faixa (comissão alta demais)
    const precoCents = Math.ceil((tier.fixedFee * 100 + costCents) / denom);
    const precoReais = toReais(precoCents);
    // Preço candidato precisa pertencer à MESMA faixa usada no cálculo do
    // preço anunciado (não confundir com a faixa pós-desconto, que pode ser
    // outra — o preço afixado no anúncio é o que baliza a faixa de comissão
    // real, ver nota em calculateShopeePricing; aqui testamos a faixa do
    // preço após desconto, que é onde tier.commissionRate realmente se aplica).
    const precoAposDesconto = precoReais * fatorPosDesconto;
    if (precoAposDesconto < tier.minPrice || precoAposDesconto > tier.maxPrice) continue;

    // A fórmula fechada usa Math.ceil pra garantir preço suficiente, mas o
    // arredondamento de comissão/imposto a centavo inteiro (dentro de
    // netProfitCentsForPrice) pode raspar uma fração de ponto percentual da
    // margem real — visto na prática (ex.: alvo 30%, resultado 29,999...%).
    // Em vez de confiar numa tolerância arbitrária (frágil — falha ou aceita
    // demais dependendo do caso), sobe 1 centavo por vez até bater de verdade,
    // com um teto de segurança (nunca deveria precisar de mais que poucos
    // centavos pra esse ajuste).
    let candCents = precoCents;
    let profitCents = null, marginReal = null;
    for (let tentativas = 0; tentativas < 50; tentativas++) {
      const candAposDesconto = toReais(candCents) * fatorPosDesconto;
      if (candAposDesconto > tier.maxPrice) { candCents = null; break; } // saiu da faixa subindo — não tem solução aqui
      profitCents = netProfitCentsForPrice(candCents, costCents, { taxRate, flashSaleDiscount, storeCouponDiscount, productCouponDiscount });
      if (profitCents == null) { candCents = null; break; }
      marginReal = (profitCents / candCents) * 100;
      if (marginReal >= margem) break;
      candCents += 1;
    }
    if (candCents == null || marginReal < margem) continue;
    candidatos.push({ price: toReais(candCents), margin: round2(marginReal), pricingTier: tier });
  }

  if (!candidatos.length) return null;
  candidatos.sort((a, b) => a.price - b.price || a.margin - b.margin);
  return candidatos[0];
}

module.exports = { SHOPEE_PRICING_TIERS, getTierForPrice, calculateShopeePricing, findIdealPrice, applyStackedDiscounts };
