// Cliente LLM compartilhado — centraliza a chamada à API da Anthropic (mesmo
// padrão que a IA Sócio Shopee já usava inline em routes/shopee.js). Fica
// desligado por padrão: sem ANTHROPIC_API_KEY no .env, `isConfigured()` é false
// e `complete()` lança um erro claro — nada de IA roda até a chave ser colada.
// Ver .claude/analise-produtos.md (Fase 3) e .claude/decisions.md.
const env = require('../config/env');
const pool = require('../db/pool');

// Haiku: barato e rápido, suficiente pra análise de texto/comentários. Trocável
// por env (AI_MODEL) sem mexer no código.
const DEFAULT_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

// Preço por 1 MILHÃO de tokens (USD). Padrão = Haiku 4.5 (in $1 / out $5).
// Sobrescreva por env se a Anthropic mudar o preço, sem precisar de deploy.
const PRICE_IN = Number(process.env.AI_PRICE_IN_PER_MTOK || 1.0);
const PRICE_OUT = Number(process.env.AI_PRICE_OUT_PER_MTOK || 5.0);

function isConfigured() {
  return !!env.anthropicApiKey;
}

// v180: preço por modelo quando a chamada usa um modelo diferente do padrão
// (ex.: leitura de nota fiscal com Claude Opus 5.5). Sem entrada → PRICE_IN/OUT.
const PRECO_MODELO = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
function costUsd(inTok, outTok, model) {
  const [pin, pout] = PRECO_MODELO[model] || [PRICE_IN, PRICE_OUT];
  return (Number(inTok || 0) / 1e6) * pin + (Number(outTok || 0) / 1e6) * pout;
}

// Registra o custo da chamada (best-effort — nunca quebra a análise se falhar).
async function logUsage({ model, feature, productId, usage }) {
  try {
    const inTok = usage?.input_tokens ?? null;
    const outTok = usage?.output_tokens ?? null;
    await pool.query(
      `INSERT INTO ai_usage_log (model, feature, product_id, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [model, feature || null, productId || null, inTok, outTok, costUsd(inTok, outTok, model)]);
  } catch (e) { console.error('[ai] logUsage', e.message); }
}

// Faz uma chamada de completude e devolve o texto puro da resposta.
// `feature`/`productId` são opcionais e servem só pra registrar o gasto.
// `user` pode ser texto ou uma lista de blocos de conteúdo (ex.: imagem base64 +
// texto — leitura de nota fiscal, v180). `extra` (opcional) vai junto no corpo
// da requisição (ex.: output_config: { effort: 'low' }).
async function complete({ system, user, maxTokens = 1500, model = DEFAULT_MODEL, feature, productId, extra = null }) {
  if (!isConfigured()) {
    const err = new Error('IA não configurada — defina ANTHROPIC_API_KEY no .env do servidor e reinicie.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const fetch = require('node-fetch');
  // Timeout duro: sem isto, uma chamada pendurada (rede do servidor sem alcançar
  // a API, resposta lenta) deixaria a rota /analisar girando pra sempre. Ajustável
  // por AI_TIMEOUT_MS. Aborta e devolve erro claro em vez de travar o spinner.
  const controller = new AbortController();
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 90000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res, data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], ...(extra || {}) }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`A IA não respondeu em ${Math.round(timeoutMs / 1000)}s (timeout). Verifique se o servidor alcança api.anthropic.com e se a chave/saldo estão ok.`);
    throw new Error('Falha ao chamar a IA: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  await logUsage({ model, feature, productId, usage: data.usage });
  if (data.stop_reason === 'refusal') throw new Error('A IA recusou este pedido.');
  // Modelos com raciocínio (ex.: Claude Opus 5.5) devolvem blocos `thinking`
  // antes do texto — pega o 1º bloco de texto, não o 1º bloco.
  return (data.content || []).find((b) => b.type === 'text')?.text || '';
}

// Igual a complete(), mas exige JSON de volta: extrai o 1º bloco {...} e parseia.
async function completeJson(opts) {
  const text = await complete(opts);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('IA não devolveu JSON válido.');
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    // Quase sempre é JSON truncado (max_tokens estourou). Erro claro em vez do
    // "Expected ',' or '}'" cru — a saída fica maior com AI_MODEL/ANALISE_MAX_TOKENS.
    throw new Error('A IA devolveu um JSON incompleto (provável limite de tokens). Aumente ANALISE_MAX_TOKENS no .env e tente de novo.');
  }
}

module.exports = { isConfigured, complete, completeJson, DEFAULT_MODEL };
