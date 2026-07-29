// Motor de IA da Análise de Produtos — Fase 3, NÚCLEO (Score + 3 agentes de
// maior valor: Comentários, Financeiro, Decisão). Uma única chamada estruturada
// (barata/rápida) que devolve JSON com uma seção por agente + o Score do Produto.
// Os outros 6 agentes (mercado, comercial, marketing, perguntas, criativos, SEO)
// entram numa fase seguinte. Ver .claude/analise-produtos.md.
const { completeJson } = require('./llm');

const n = (v) => (v == null || v === '' ? null : Number(v));
const money = (v) => (n(v) == null ? 0 : Number(v));

// Monta o contexto REAL (sem inventar nada) que a IA recebe: custos do produto +
// resumo dos concorrentes coletados + todo o texto de comentários (auto+manual).
// Limites de entrada — mantêm o custo por análise BAIXO (menos tokens de input).
// Ajustáveis por env sem tocar no código.
const MAX_ADS = Number(process.env.ANALISE_MAX_ADS || 10);          // nº de concorrentes enviados
const MAX_COMMENT_CHARS = Number(process.env.ANALISE_MAX_COMMENT_CHARS || 3500); // teto do texto de comentários
// Teto de SAÍDA da análise. 1200 truncava o JSON com muitos concorrentes (JSON
// cortado → erro de parse). 3000 dá folga; ajustável por env.
const CORE_MAX_TOKENS = Number(process.env.ANALISE_MAX_TOKENS || 3000);

function buildContext(produto, anuncios) {
  const custoAquisicao = money(produto.preco_compra) + money(produto.frete_entrada) + money(produto.embalagem);
  const todos = anuncios || [];
  // Só os concorrentes mais relevantes (mais vendidos/avaliados) pra não inflar o prompt.
  const escolhidos = todos.slice()
    .sort((a, b) => (n(b.comentarios) || 0) - (n(a.comentarios) || 0))
    .slice(0, MAX_ADS);
  // Campos compactos (só o essencial pra análise) — nomes curtos economizam tokens.
  const ads = escolhidos.map((a) => {
    const o = {
      t: a.titulo, p: n(a.preco), nota: n(a.nota), vend: a.vendas,
      rep: a.reputacao, full: a.full || undefined, flex: a.flex || undefined,
    };
    // Vendas REAIS por janela (Shopping de Preço) — só inclui o que foi preenchido.
    const vr = {};
    if (n(a.vendas_7d) != null || n(a.preco_medio_7d) != null) vr['7d'] = { un: n(a.vendas_7d), preco_medio: n(a.preco_medio_7d) };
    if (n(a.vendas_15d) != null || n(a.preco_medio_15d) != null) vr['15d'] = { un: n(a.vendas_15d), preco_medio: n(a.preco_medio_15d) };
    if (n(a.vendas_21d) != null || n(a.preco_medio_21d) != null) vr['21d'] = { un: n(a.vendas_21d), preco_medio: n(a.preco_medio_21d) };
    if (n(a.vendas_30d) != null || n(a.preco_medio_30d) != null) vr['30d'] = { un: n(a.vendas_30d), preco_medio: n(a.preco_medio_30d) };
    if (Object.keys(vr).length) o.vendas_reais = vr;
    return o;
  });
  const temVendasReais = ads.some((a) => a.vendas_reais);
  // Texto de comentários (visíveis + colados) com teto rígido de caracteres.
  const comentarios = escolhidos
    .map((a) => [a.comentarios_auto, a.comentarios_texto].filter(Boolean).join('\n'))
    .filter(Boolean).join('\n---\n').slice(0, MAX_COMMENT_CHARS);
  const precos = ads.map((a) => a.p).filter((p) => p != null);
  return {
    produto: {
      nome: produto.produto, fornecedor: produto.fornecedor,
      custo_aquisicao_rs: Number(custoAquisicao.toFixed(2)),
      preco_compra_rs: n(produto.preco_compra), frete_entrada_rs: n(produto.frete_entrada),
      embalagem_rs: n(produto.embalagem),
      taxa_marketplace_pct: n(produto.taxa_mp), imposto_pct: n(produto.imposto),
    },
    concorrentes: {
      total: ads.length,
      preco_min: precos.length ? Math.min(...precos) : null,
      preco_max: precos.length ? Math.max(...precos) : null,
      tem_vendas_reais: temVendasReais,
      lista: ads,
    },
    comentarios_texto: comentarios || null,
  };
}

const SYSTEM = `Você é um comitê de analistas sênior de e-commerce que avalia se vale a pena um vendedor do Mercado Livre COMPRAR e VENDER um produto. Você recebe DADOS REAIS (custos do vendedor + concorrentes coletados + comentários dos anúncios). Trabalhe SÓ com esses dados — NUNCA invente número, preço ou concorrente que não esteja no JSON. Valores em Reais (R$).

Responda SOMENTE com um JSON válido (sem markdown, sem texto fora do JSON) neste formato exato:
{
  "comentarios": {
    "resumo": "1-2 frases sobre o que os clientes acham nos anúncios concorrentes",
    "reclamacoes": ["principais reclamações recorrentes"],
    "elogios": ["principais elogios recorrentes"],
    "oportunidades": ["como se diferenciar aproveitando as reclamações"]
  },
  "financeiro": {
    "custo_total_rs": number,            // custo de aquisição informado
    "preco_sugerido_rs": number,         // preço de venda recomendado, competitivo vs concorrentes
    "margem_liquida_pct": number,        // margem % no preço sugerido, já descontando taxa_marketplace_pct e imposto_pct sobre o preço
    "lucro_unitario_rs": number,         // lucro em R$ por unidade no preço sugerido
    "resumo": "explicação curta do racional de preço e margem"
  },
  "decisao": {
    "veredito": "VALE" | "ATENCAO" | "NAO_VALE",
    "justificativa": "por que, em 1-3 frases",
    "riscos": ["riscos concretos"],
    "proximos_passos": ["ações práticas se for VALE/ATENCAO"]
  },
  "score": {
    "valor": number,                     // 0 a 100: atratividade geral do produto
    "explicacao": "o que puxou o score pra cima/baixo"
  }
}

Regras de cálculo do financeiro: margem_liquida_pct = ((preco_sugerido - custo_total - preco_sugerido*(taxa_marketplace_pct+imposto_pct)/100) / preco_sugerido) * 100. Se faltar custo (custo_aquisicao_rs = 0 ou nulo), diga no resumo que a análise financeira é parcial e não force números.

VENDAS REAIS (PESO MÁXIMO): quando um concorrente tiver o campo "vendas_reais" (unidades vendidas e preço médio praticado em 7/15/21/30 dias, vindos do Shopping de Preço), esse é o dado MAIS confiável que existe — dê PESO ALTO a ele. Use as unidades pra dimensionar a DEMANDA/volume real do mercado e o preço_medio pra ancorar o preço_sugerido no valor REALMENTE praticado nas vendas (não só no preço de vitrine). Cite esses números na justificativa e no financeiro. Se NENHUM concorrente tiver vendas_reais (tem_vendas_reais=false), diga explicitamente que a estimativa de demanda é fraca por falta desses dados e seja mais conservador no score/decisão.`;

// Roda o núcleo e devolve { comentarios, financeiro, decisao, score }.
async function analisarNucleo(produto, anuncios) {
  const ctx = buildContext(produto, anuncios);
  const user = `Analise o produto abaixo e devolva o JSON.\n\nDADOS:\n${JSON.stringify(ctx, null, 2)}`;
  const result = await completeJson({ system: SYSTEM, user, maxTokens: CORE_MAX_TOKENS, feature: 'analise', productId: produto.id });
  // normaliza o score pra um inteiro 0-100
  let score = Number(result?.score?.valor);
  if (!Number.isFinite(score)) score = null;
  else score = Math.max(0, Math.min(100, Math.round(score)));
  return { result, score, contexto: ctx };
}

// ── Agente de Criativos ────────────────────────────────────────────────────
// Gera 7 briefs de imagem (JSON) pro usuário colar no ChatGPT e criar as fotos.
// Cada criativo QUEBRA UMA OBJEÇÃO real tirada dos comentários dos concorrentes.
const CRIATIVOS_SYSTEM = `Você é diretor de arte de e-commerce. Gera BRIEFS de imagem (para outra IA de imagem, tipo ChatGPT/DALL-E) que vendem um produto no Mercado Livre. Você recebe o produto e os comentários REAIS dos concorrentes. Extraia as principais OBJEÇÕES/dúvidas/reclamações dos clientes e crie criativos que as QUEBREM visualmente (prova, comparação, selo, destaque de atributo).

Responda SOMENTE com um JSON válido (sem markdown) neste formato EXATO:
{
  "criativos": [
    {
      "objecao_quebrada": "qual objeção do cliente esta imagem resolve (curto)",
      "composicao": {
        "cenario": "descrição do ambiente/fundo",
        "sujeito": "o que aparece em destaque",
        "detalhe_produto": "descrição fiel do produto (material, cor, textura, acabamento) — baseie-se no nome/tipo do produto",
        "camera": "ângulo, lente, foco, profundidade"
      },
      "direcao_de_arte": {
        "iluminacao": "esquema de luz",
        "paleta_cores": "cores dominantes",
        "estilo_visual": "photorealistic, 8k, sharp focus, studio lighting, premium e-commerce"
      },
      "elementos_visual_copy": {
        "texto_principal": "headline curta que quebra a objeção",
        "texto_secundario": "apoio curto",
        "posicao_texto": "onde fica o texto sem cobrir o produto",
        "estilo_texto": "fonte/peso/cor",
        "grafismo": "seta/círculo/comparativo que reforça o ponto",
        "selo": "selo/badge (ex.: 'Pronta Entrega', 'Algodão 100%', 'Garantia')"
      },
      "formato": "proporção da imagem (ex.: '1080:1080' pra foto principal quadrada do ML, ou '1080:1350' vertical)"
    }
  ]
}

Regras: EXATAMENTE 7 criativos, cada um quebrando uma objeção DIFERENTE (baseada nos comentários; se faltarem comentários, use objeções típicas do tipo de produto). Textos em português brasileiro, curtos e vendedores. NÃO invente atributos que contrariem o produto.`;

async function gerarCriativos(produto, anuncios) {
  const ctx = buildContext(produto, anuncios);
  const user = `Gere os 7 criativos para o produto abaixo. Use as OBJEÇÕES dos comentários.\n\nDADOS:\n${JSON.stringify({ produto: ctx.produto, comentarios_texto: ctx.comentarios_texto }, null, 2)}`;
  const data = await completeJson({ system: CRIATIVOS_SYSTEM, user, maxTokens: 4000, feature: 'criativos', productId: produto.id });
  const criativos = Array.isArray(data?.criativos) ? data.criativos.slice(0, 7) : [];
  return { criativos };
}

module.exports = { buildContext, analisarNucleo, gerarCriativos };
