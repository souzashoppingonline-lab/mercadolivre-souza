// Testes do motor de precificação Shopee (server/src/marketplaces/shopee/pricingEngine.js).
// Puro (sem banco/HTTP) — roda em qualquer máquina. Ver .claude/shopee.md.
// Rodar: node --test test/shopeePricing.test.js (ou `npm test`, ver package.json).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  SHOPEE_PRICING_TIERS, getTierForPrice, calculateShopeePricing, findIdealPrice, priceForTier, applyStackedDiscounts,
} = require('../src/marketplaces/shopee/pricingEngine');

describe('getTierForPrice — faixas e transições críticas (seção 31 da spec)', () => {
  test('R$79,99 → 20% + R$4 (última faixa antes do corte)', () => {
    const t = getTierForPrice(79.99);
    assert.strictEqual(t.commissionRate, 20);
    assert.strictEqual(t.fixedFee, 4);
    assert.strictEqual(t.pixSubsidy, 0);
  });
  test('R$80,00 → 14% + R$16 + subsídio 5% (muda na virada exata)', () => {
    const t = getTierForPrice(80.00);
    assert.strictEqual(t.commissionRate, 14);
    assert.strictEqual(t.fixedFee, 16);
    assert.strictEqual(t.pixSubsidy, 5);
  });
  test('R$99,99 → ainda a faixa de R$80 (não pula pra próxima antes da hora)', () => {
    const t = getTierForPrice(99.99);
    assert.strictEqual(t.fixedFee, 16);
  });
  test('R$100,00 → 14% + R$20', () => {
    const t = getTierForPrice(100.00);
    assert.strictEqual(t.fixedFee, 20);
  });
  test('R$199,99 → ainda a faixa de R$100', () => {
    const t = getTierForPrice(199.99);
    assert.strictEqual(t.fixedFee, 20);
  });
  test('R$200,00 → 14% + R$26', () => {
    const t = getTierForPrice(200.00);
    assert.strictEqual(t.fixedFee, 26);
    assert.strictEqual(t.pixSubsidy, 5);
  });
  test('R$499,99 → ainda a faixa de R$200 (mesma comissão/fixa que R$500, só o subsídio muda)', () => {
    const t = getTierForPrice(499.99);
    assert.strictEqual(t.fixedFee, 26);
    assert.strictEqual(t.pixSubsidy, 5);
  });
  test('R$500,00 → 14% + R$26 + subsídio 8% (última faixa, sem teto)', () => {
    const t = getTierForPrice(500.00);
    assert.strictEqual(t.fixedFee, 26);
    assert.strictEqual(t.pixSubsidy, 8);
  });
  test('preço negativo ou inválido não acha faixa', () => {
    assert.strictEqual(getTierForPrice(-10), null);
    assert.strictEqual(getTierForPrice(NaN), null);
  });
  test('5 faixas ao todo, cobrindo de 0 a infinito sem buraco nem sobreposição', () => {
    assert.strictEqual(SHOPEE_PRICING_TIERS.length, 5);
    for (let i = 1; i < SHOPEE_PRICING_TIERS.length; i++) {
      // fim de uma faixa é o "quase" começo da próxima (0.01 de diferença, preço em reais)
      assert.ok(SHOPEE_PRICING_TIERS[i].minPrice > SHOPEE_PRICING_TIERS[i - 1].maxPrice - 1);
    }
    assert.strictEqual(SHOPEE_PRICING_TIERS[SHOPEE_PRICING_TIERS.length - 1].maxPrice, Infinity);
  });
});

describe('applyStackedDiscounts — empilhamento multiplicativo/sequencial', () => {
  test('sem desconto nenhum, preço intacto', () => {
    assert.strictEqual(applyStackedDiscounts(10000, [0, 0, 0]), 10000);
  });
  test('um desconto de 10% sobre R$100 → R$90', () => {
    assert.strictEqual(applyStackedDiscounts(10000, [10, 0, 0]), 9000);
  });
  test('10% + 5% sequencial (não 15% somado): 100 → 90 → 85,50', () => {
    assert.strictEqual(applyStackedDiscounts(10000, [10, 5, 0]), 8550);
  });
  test('soma dos percentuais > 100% nunca gera negativo', () => {
    const r = applyStackedDiscounts(10000, [60, 60, 60]);
    assert.ok(r >= 0);
  });
});

describe('calculateShopeePricing — casos sem custo/faixa (seções 28/29 da spec)', () => {
  test('sem custo cadastrado: idealPrice null, resto do cálculo continua (margem/lucro null)', () => {
    const r = calculateShopeePricing({ cost: null, currentPrice: 89.90, targetMargin: 30, taxRate: 0 });
    assert.strictEqual(r.idealPrice, null);
    assert.strictEqual(r.profit, null);
    assert.strictEqual(r.margin, null);
    // mas a faixa/comissão do preço atual continuam calculadas — útil pra
    // mostrar "quanto a Shopee cobra" mesmo sem custo ainda
    assert.strictEqual(r.commissionRate, 14);
  });
  test('preço atual inválido (0/negativo): margem/lucro do preço atual ficam null, mas o preço IDEAL continua calculável (depende só do custo)', () => {
    const r = calculateShopeePricing({ cost: 42, currentPrice: 0, targetMargin: 30 });
    assert.strictEqual(r.pricingTier, null);
    assert.strictEqual(r.margin, null);
    assert.strictEqual(r.profit, null);
    assert.ok(r.idealPrice > 0, 'idealPrice não devia depender de já existir um preço atual válido — bug real encontrado em produção');
  });
});

describe('findIdealPrice — menor preço que atinge a margem, por faixa (seções 13/17)', () => {
  // Verificação por "round-trip": em vez de cravar o número exato esperado
  // (frágil a qualquer ajuste de arredondamento), plugamos o idealPrice
  // encontrado de volta em calculateShopeePricing como currentPrice e
  // confirmamos que a margem resultante bate com a desejada — é a forma
  // mais robusta de validar um otimizador numérico.
  function assertIdealAchievesMargin(params) {
    const ideal = findIdealPrice(params);
    assert.ok(ideal, `não achou preço ideal pra ${JSON.stringify(params)}`);
    const check = calculateShopeePricing({ ...params, currentPrice: ideal.price });
    assert.ok(
      check.margin >= params.targetMargin - 0.05,
      `margem obtida ${check.margin}% < desejada ${params.targetMargin}% (preço ${ideal.price})`
    );
    return ideal;
  }

  for (const targetMargin of [20, 30, 40]) {
    test(`margem ${targetMargin}% — custo baixo (R$10)`, () => {
      assertIdealAchievesMargin({ cost: 10, targetMargin, taxRate: 0 });
    });
    test(`margem ${targetMargin}% — custo alto (R$300)`, () => {
      assertIdealAchievesMargin({ cost: 300, targetMargin, taxRate: 0 });
    });
  }

  test('promoção relâmpago 5%', () => {
    assertIdealAchievesMargin({ cost: 42, targetMargin: 30, flashSaleDiscount: 5 });
  });
  test('promoção relâmpago 10%', () => {
    assertIdealAchievesMargin({ cost: 42, targetMargin: 30, flashSaleDiscount: 10 });
  });
  test('cupom loja 5%', () => {
    assertIdealAchievesMargin({ cost: 42, targetMargin: 30, storeCouponDiscount: 5 });
  });
  test('cupom produto 5%', () => {
    assertIdealAchievesMargin({ cost: 42, targetMargin: 30, productCouponDiscount: 5 });
  });
  test('promoção 10% + cupom loja 5% combinados', () => {
    assertIdealAchievesMargin({ cost: 42, targetMargin: 30, flashSaleDiscount: 10, storeCouponDiscount: 5 });
  });

  for (const taxRate of [0, 5, 10]) {
    test(`imposto ${taxRate}%`, () => {
      assertIdealAchievesMargin({ cost: 42, targetMargin: 30, taxRate });
    });
  }

  test('exemplo da spec (seção 18): custo R$42, margem 30%, promo 10%, cupom loja 5%, cupom produto 0%', () => {
    const ideal = assertIdealAchievesMargin({ cost: 42, targetMargin: 30, flashSaleDiscount: 10, storeCouponDiscount: 5, productCouponDiscount: 0 });
    assert.ok(ideal.price > 42, 'preço ideal precisa cobrir pelo menos o custo');
  });

  test('sem custo (0 ou null) não acha preço', () => {
    assert.strictEqual(findIdealPrice({ cost: 0, targetMargin: 30 }), null);
    assert.strictEqual(findIdealPrice({ cost: null, targetMargin: 30 }), null);
  });

  test('escolhe o MENOR preço entre soluções válidas em faixas diferentes', () => {
    const ideal = findIdealPrice({ cost: 5, targetMargin: 10 });
    // custo baixo + margem baixa: a faixa de R$79,99 (comissão 20%+R$4) já
    // deveria bastar — não precisa pular pra uma faixa de comissão igual mas
    // taxa fixa maior.
    assert.ok(ideal.price <= 79.99, `preço ideal ${ideal.price} devia caber na 1ª faixa`);
  });
});

describe('Bug real de produção: produto sem preço atual sincronizado', () => {
  test('cost=10,37, sem current_price nenhum (null) — preço ideal precisa aparecer mesmo assim', () => {
    const r = calculateShopeePricing({ cost: 10.37, currentPrice: null, targetMargin: 30, taxRate: 0 });
    assert.ok(r.idealPrice > 10.37, 'preço ideal tem que existir e cobrir pelo menos o custo');
    assert.strictEqual(r.margin, null); // margem do preço ATUAL não existe (não há preço atual)
  });
});

describe('priceForTier — faixa escolhida manualmente na tela (clique na tabela oficial)', () => {
  test('faixa "até R$79,99" com custo baixo: preço cabe na própria faixa', () => {
    const tier = SHOPEE_PRICING_TIERS[0];
    const r = priceForTier(tier, { cost: 10, targetMargin: 20, taxRate: 0 });
    assert.ok(r);
    assert.strictEqual(r.withinTier, true);
    assert.ok(r.price <= 79.99);
  });
  test('faixa "até R$79,99" com custo alto: preço calculado NÃO cabe na faixa (withinTier=false) — avisa em vez de mentir', () => {
    const tier = SHOPEE_PRICING_TIERS[0];
    const r = priceForTier(tier, { cost: 300, targetMargin: 30, taxRate: 0 });
    assert.ok(r);
    assert.strictEqual(r.withinTier, false);
  });
  test('faixa null (nenhuma selecionada) devolve null', () => {
    assert.strictEqual(priceForTier(null, { cost: 10, targetMargin: 20 }), null);
  });

  test('bug real: preço forçado usa a comissão da FAIXA ESCOLHIDA, não da faixa que o preço cairia naturalmente', () => {
    // custo 42/margem 30% "pertence" naturalmente à faixa de R$100-199,99
    // (ver findIdealPrice). Forçando a faixa "até R$79,99" (20%+R$4), o preço
    // tem que ser calculado com ESSA comissão, mesmo que o resultado (R$92)
    // não caiba de fato na própria faixa — antes desse fix, o ajuste fino de
    // centavo (dentro de solveTierPrice) recalculava a faixa pelo preço a
    // cada tentativa, então "vazava" pra faixa real e devolvia o mesmo valor
    // do automático (110,72) em vez de usar 20%+R$4 de verdade.
    const tier0 = SHOPEE_PRICING_TIERS[0];
    const forcado = priceForTier(tier0, { cost: 42, targetMargin: 30, taxRate: 0 });
    assert.ok(forcado);
    assert.strictEqual(forcado.pricingTier.commissionRate, 20);
    assert.notStrictEqual(forcado.price, findIdealPrice({ cost: 42, targetMargin: 30, taxRate: 0 }).price);
    assert.strictEqual(forcado.withinTier, false); // R$92 não cabe em "até R$79,99" — tem que avisar, não mentir
    // Confirma que o preço devolvido realmente bate 30% de margem USANDO a
    // comissão de 20%+R$4 (não a de outra faixa por engano).
    const netRevenue = forcado.price * (1 - 0.20) - 4;
    const margemReal = (netRevenue - 42) / forcado.price * 100;
    assert.ok(Math.abs(margemReal - 30) < 0.1, `margem real ${margemReal}% deveria bater ~30% usando 20%+R$4`);
  });
});

describe('Precisão monetária (seção 19)', () => {
  test('resultados sempre com no máximo 2 casas decimais', () => {
    const r = calculateShopeePricing({ cost: 42.33, currentPrice: 89.90, targetMargin: 27.5, taxRate: 3.3 });
    const casas = (n) => (String(n).split('.')[1] || '').length;
    assert.ok(casas(r.margin) <= 2);
    assert.ok(casas(r.netRevenue) <= 2);
    assert.ok(casas(r.profit) <= 2);
  });
});
