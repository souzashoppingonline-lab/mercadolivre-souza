// Cliente LLM compartilhado — centraliza a chamada à API da Anthropic (mesmo
// padrão que a IA Sócio Shopee já usava inline em routes/shopee.js). Fica
// desligado por padrão: sem ANTHROPIC_API_KEY no .env, `isConfigured()` é false
// e `complete()` lança um erro claro — nada de IA roda até a chave ser colada.
// Ver .claude/analise-produtos.md (Fase 3) e .claude/decisions.md.
const env = require('../config/env');

// Haiku: barato e rápido, suficiente pra análise de texto/comentários. Trocável
// por env (AI_MODEL) sem mexer no código.
const DEFAULT_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

function isConfigured() {
  return !!env.anthropicApiKey;
}

// Faz uma chamada de completude e devolve o texto puro da resposta.
async function complete({ system, user, maxTokens = 1500, model = DEFAULT_MODEL }) {
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
