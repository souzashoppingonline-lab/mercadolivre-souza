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

function costUsd(inTok, outTok) {
  return (Number(inTok || 0) / 1e6) * PRICE_IN + (Number(outTok || 0) / 1e6) * PRICE_OUT;
}

// Registra o custo da chamada (best-effort — nunca quebra a análise se falhar).
async function logUsage({ model, feature, productId, usage }) {
  try {
    const inTok = usage?.input_tokens ?? null;
    const outTok = usage?.output_tokens ?? null;
    await pool.query(
      `INSERT INTO ai_usage_log (model, feature, product_id, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [model, feature || null, productId || null, inTok, outTok, costUsd(inTok, outTok)]);
  } catch (e) { console.error('[ai] logUsage', e.message); }
}

// Faz uma chamada de completude e devolve o texto puro da resposta.
// `feature`/`productId` são opcionais e servem só pra registrar o gasto.
async function complete({ system, user, maxTokens = 1500, model = DEFAULT_MODEL, feature, productId }) {
  if (!isConfigured()) {
    const err = new Error('IA não configurada — defina ANTHROPIC_API_KEY no .env do servidor e reinicie.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const fetch = require('node-fetch');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  await logUsage({ model, feature, productId, usage: data.usage });
  return data.content?.[0]?.text || '';
}

// Igual a complete(), mas exige JSON de volta: extrai o 1º bloco {...} e parseia.
async function completeJson(opts) {
  const text = await complete(opts);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('IA não devolveu JSON válido.');
  return JSON.parse(m[0]);
}

module.exports = { isConfigured, complete, completeJson, DEFAULT_MODEL };
