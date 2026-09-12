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

  // idealPrice só depende do CUSTO + margem desejada — nunca do preço atual.
  // Calcula sempre que houver custo, mesmo sem preço atual válido (produto
  // ainda sem preço sincronizado, ou preço zerado) — bug real encontrado em
  // produção: antes retornava idealPrice=null junto com o resto quando não
  // havia preço atual, mas "quanto eu deveria cobrar" é uma pergunta válida
  // independente de já existir (ou não) um preço vigente.
  const idealPrice = costCents != null
    ? findIdealPrice({ cost: toReais(costCents), targetMargin, taxRate, flashSaleDiscount, storeCouponDiscount, productCouponDiscount })
    : null;

  if (!pricingTier || priceCents <= 0) {
    return {
      currentPrice: toReais(priceCents), idealPrice: idealPrice?.price ?? null, commissionRate: null, fixedFee: null,
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
// um custo dados — reaproveitado por findIdealPrice/solveTierPrice.
// `forceTier`: quando informado, usa a comissão/taxa fixa DESSA faixa em vez
// de redescobrir pelo preço — essencial pra priceForTier (faixa escolhida
// manualmente): sem isso, ao subir o preço centavo a centavo (ajuste de
// arredondamento), o preço podia escapar pra outra faixa real e o cálculo
// passava a usar a comissão ERRADA (bug encontrado testando a seleção manual
// de faixa em produção — o preço "forçado" saía igual ao automático).
function netProfitCentsForPrice(priceCents, costCents, { taxRate = 0, flashSaleDiscount = 0, storeCouponDiscount = 0, productCouponDiscount = 0, forceTier = null } = {}) {
  const tier = forceTier || getTierForPrice(toReais(priceCents));
  if (!tier) return null;
  const afterDiscountsCents = applyStackedDiscounts(priceCents, [flashSaleDiscount, storeCouponDiscount, productCouponDiscount]);
  const afterTier = forceTier || getTierForPrice(toReais(afterDiscountsCents)) || tier;
  const commissionCents = Math.round(afterDiscountsCents * (afterTier.commissionRate / 100));
  const fixedFeeCents = toCents(afterTier.fixedFee);
  const taxCents = Math.round(afterDiscountsCents * (Number(taxRate) || 0) / 100);
  // Subsídio Pix propositalmente fora da conta — ver nota em calculateShopeePricing.
  return afterDiscountsCents - commissionCents - fixedFeeCents - taxCents - costCents;
}

// Resolve o preço mínimo que atinge a margem desejada DENTRO de uma faixa
// específica (fórmula fechada + ajuste fino de 1 centavo — ver nota abaixo).
// Reaproveitada por findIdealPrice (testa as 5 faixas e pega a melhor) e por
// priceForTier (usuário escolhe a faixa manualmente, ver seleção da tabela
// oficial na tela — "em qual faixa eu quero vender"). Devolve `withinTier:
// false` quando o preço calculado não fica de fato dentro da faixa pedida
// (ex.: custo alto demais pra caber na faixa "até R$79,99") — nesse caso o
// preço ainda é devolvido (pra mostrar "não dá pra vender nessa faixa com
// esse custo/margem"), mas o chamador decide se aceita ou não.
function solveTierPrice(tier, { cost, targetMargin = 0, taxRate = 0, flashSaleDiscount = 0, storeCouponDiscount = 0, productCouponDiscount = 0 }) {
  const costCents = toCents(cost);
  if (costCents <= 0) return null;
  const margem = Math.max(0, Math.min(99.999, Number(targetMargin) || 0));
  const imposto = Math.max(0, Number(taxRate) || 0);
  const descontoTotalFrac = 1
    - (1 - Math.max(0, Math.min(100, flashSaleDiscount)) / 100)
    * (1 - Math.max(0, Math.min(100, storeCouponDiscount)) / 100)
    * (1 - Math.max(0, Math.min(100, productCouponDiscount)) / 100);
  const fatorPosDesconto = 1 - descontoTotalFrac; // preço anunciado × isso = preço após descontos

  // netRevenue = afterDiscount*(1 - comissão% - imposto%) - taxaFixa (SEM
  // subsídio Pix — pedido explícito do usuário, nunca dá pra garantir que o
  // comprador vai pagar via Pix).
  // profit = netRevenue - cost; margin = profit / preçoAnunciado (não sobre o
  // preço após desconto — margem é "lucro sobre o preço de venda anunciado",
  // conforme o texto auxiliar do card 1 da spec).
  // preçoAnunciado*(fatorPosDesconto*(1-com%-imp%) - margem%) = taxaFixa + cost
  const fatorLiquido = fatorPosDesconto * (1 - tier.commissionRate / 100 - imposto / 100);
  const denom = fatorLiquido - margem / 100;
  if (denom <= 0) return null; // margem desejada inatingível nessa faixa (comissão alta demais)
  const precoCents = Math.ceil((tier.fixedFee * 100 + costCents) / denom);

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
    // forceTier: sempre a faixa sendo testada aqui (`tier`), nunca a que o
    // preço "cairia naturalmente" — é assim que dá pra saber se o preço
    // pertence de fato à faixa pedida (withinTier abaixo) em vez de misturar
    // a comissão de uma faixa com o preço de outra.
    profitCents = netProfitCentsForPrice(candCents, costCents, { taxRate, flashSaleDiscount, storeCouponDiscount, productCouponDiscount, forceTier: tier });
    if (profitCents == null) return null;
    marginReal = (profitCents / candCents) * 100;
    if (marginReal >= margem) break;
    candCents += 1;
  }
  if (marginReal < margem) return null;

  const precoReais = toReais(candCents);
  const precoAposDesconto = precoReais * fatorPosDesconto;
  const withinTier = precoAposDesconto >= tier.minPrice && precoAposDesconto <= tier.maxPrice;
  return { price: precoReais, margin: round2(marginReal), pricingTier: tier, withinTier };
}

// Menor preço que atinge a margem desejada (spec seções 13/17): testa as 5
// faixas com solveTierPrice, descarta as que não pertencem de fato à faixa
// calculada, e devolve a de menor preço entre as válidas. Não assume que uma
// fórmula única serve pra todas as faixas (comissão/taxa fixa mudam).
function findIdealPrice(params) {
  const candidatos = SHOPEE_PRICING_TIERS
    .map((tier) => solveTierPrice(tier, params))
    .filter((c) => c && c.withinTier);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => a.price - b.price || a.margin - b.margin);
  return candidatos[0];
}

// Preço pra vender DENTRO de uma faixa escolhida pelo usuário (clique na
// tabela oficial de comissão na tela) — "eu quero vender nessa faixa,
// quanto eu cobro pra bater a margem?". Diferente de findIdealPrice (que
// escolhe a MELHOR faixa sozinho), aqui a faixa já vem definida; devolve o
// preço mesmo que ele escape da faixa (`withinTier: false`), pro frontend
// avisar "com esse custo/margem não dá pra vender nessa faixa".
function priceForTier(tier, params) {
  if (!tier) return null;
  return solveTierPrice(tier, params);
}

module.exports = { SHOPEE_PRICING_TIERS, getTierForPrice, calculateShopeePricing, findIdealPrice, priceForTier, applyStackedDiscounts };
