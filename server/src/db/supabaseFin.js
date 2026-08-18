// Cliente REST do Supabase do módulo FINANCEIRO — banco SEPARADO do Postgres
// principal (dados reais de outra ferramenta; nada pode ser perdido). Isolado e
// READ-ONLY por design: só faz GET no PostgREST (/rest/v1). Nunca escreve, nunca
// migra. Credenciais vêm do .env (env.financeiro), nunca do frontend.
// Ver .claude/modules.md.
const env = require('../config/env');

const BASE = () => (env.financeiro.supabaseUrl || '').replace(/\/+$/, '');
const KEY = () => env.financeiro.supabaseKey || '';

function isConfigured() {
  return !!(BASE() && KEY());
}

function headers() {
  // Mesmo comportamento do cliente oficial supabase-js (o que o Readdy usa neste
  // mesmo projeto e funciona): a chave vai NOS DOIS headers — `apikey` e
  // `Authorization: Bearer`. Vale para anon/publishable/secret. (A doc nova diz
  // pra não mandar no Bearer, mas na prática deste projeto os dois headers são o
  // que conecta — então seguimos o supabase-js.)
  const k = KEY();
  return { apikey: k, Authorization: `Bearer ${k}` };
}

// Prefixo mascarado da chave carregada — só pra diagnóstico na tela de status
// (confirma QUAL chave o servidor está usando, sem expor a chave inteira).
function keyHint() {
  const k = KEY();
  if (!k) return null;
  return `${k.slice(0, 14)}…(${k.length})`;
}

// GET cru no PostgREST. `path` começa com '/'. Lança erro com status legível.
async function get(path) {
  if (!isConfigured()) {
    const e = new Error('Módulo Financeiro não configurado — defina SUPABASE_FIN_URL e SUPABASE_FIN_KEY no .env do servidor.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const url = `${BASE()}/rest/v1${path}`;
  const r = await fetch(url, { headers: headers() });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!r.ok) {
    const e = new Error(`Supabase respondeu ${r.status}: ${typeof body === 'string' ? body : (body?.message || JSON.stringify(body))}`);
    e.status = r.status;
    throw e;
  }
  return body;
}

// Lista as tabelas do Supabase. O índice OpenAPI da raiz (/rest/v1/) costuma
// dar 401 com a chave pública (só a service_role introspecciona), então:
//  1) tenta a raiz com apikey-only e depois com os dois headers;
//  2) se falhar, usa a lista configurada em SUPABASE_FIN_TABLES (CSV) — jeito
//     garantido quando a chave anon não lista o índice.
async function listTables() {
  const base = BASE();
  const attempts = [{ apikey: KEY() }, headers()];
  for (const h of attempts) {
    try {
      const r = await fetch(`${base}/rest/v1/`, { headers: h });
      if (r.ok) {
        const spec = await r.json().catch(() => ({}));
        const defs = spec?.definitions || spec?.components?.schemas || {};
        const keys = Object.keys(defs);
        if (keys.length) return keys.sort();
      }
    } catch (_) { /* tenta a próxima estratégia */ }
  }
  const configured = String(process.env.SUPABASE_FIN_TABLES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured.sort();
  const e = new Error('A chave não consegue listar o índice do banco (introspecção bloqueada). Use a chave service_role (sb_secret) OU liste as tabelas em SUPABASE_FIN_TABLES no .env.');
  e.status = 422;
  throw e;
}

// Prévia de linhas de uma tabela (READ-ONLY). Sanitiza o nome (PostgREST usa o
// nome como path) e limita a quantidade. `limit` teto de 200.
async function previewTable(nome, limit = 50) {
  if (!/^[a-zA-Z0-9_]+$/.test(String(nome || ''))) {
    const e = new Error('nome de tabela inválido'); e.status = 400; throw e;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return get(`/${nome}?limit=${lim}`);
}

// Busca linhas de uma tabela (READ-ONLY) com limite maior — pra telas reais
// (fluxo de caixa, etc.). `order` opcional no formato coluna(.asc|.desc).
async function selectRows(nome, limit = 1000, order = '', filtro = '') {
  if (!/^[a-zA-Z0-9_]+$/.test(String(nome || ''))) {
    const e = new Error('nome de tabela inválido'); e.status = 400; throw e;
  }
  const lim = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  let path = `/${nome}?limit=${lim}`;
  if (order && /^[a-zA-Z0-9_]+(\.(asc|desc))?$/.test(order)) path += `&order=${encodeURIComponent(order)}`;
  // Filtro simples de igualdade: "coluna=eq.valor" (coluna sanitizada, valor codificado).
  if (filtro) {
    const m = /^([a-zA-Z0-9_]+)=eq\.(.+)$/.exec(String(filtro));
    if (m) path += `&${m[1]}=eq.${encodeURIComponent(m[2])}`;
  }
  return get(path);
}

// ── ESCRITA (migração: este sistema passa a gravar no Supabase) ──────────────
// Allowlist de tabelas que a UI pode gravar — cresce conforme as telas ficam
// prontas. Nunca gravar em tabela fora desta lista. Escrita exige chave
// service_role (sb_secret); com a publishable o Supabase costuma recusar (RLS).
const WRITE_ALLOW = new Set(['sales_entries', 'expenses', 'expense_categories', 'boletos_mensais', 'receivables', 'boleto_categories', 'cartoes', 'parcelas_cartao', 'parcela_tags', 'fatura_pagamentos', 'boletos_recorrentes', 'cash_flow_entries', 'cash_flow_categories', 'cash_flow_recurring', 'contas_bancarias', 'conta_empresas', 'manual_cash_flow_values', 'forecast_starting_balance', 'pedido_empresas', 'pedidos', 'pedido_fornecedores', 'pedido_contatos']);
function assertWritable(nome) {
  if (!/^[a-zA-Z0-9_]+$/.test(String(nome || '')) || !WRITE_ALLOW.has(nome)) {
    const e = new Error(`Escrita não permitida na tabela "${nome}".`); e.status = 403; throw e;
  }
}
async function writeReq(method, path, body) {
  if (!isConfigured()) { const e = new Error('Módulo Financeiro não configurado.'); e.code = 'NOT_CONFIGURED'; throw e; }
  const r = await fetch(`${BASE()}/rest/v1${path}`, {
    method,
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text(); let b; try { b = text ? JSON.parse(text) : null; } catch (_) { b = text; }
  if (!r.ok) {
    const msg = typeof b === 'string' ? b : (b?.message || b?.hint || JSON.stringify(b));
    const e = new Error(`Supabase ${r.status}: ${msg}`); e.status = r.status; throw e;
  }
  return b;
}
async function insertRow(nome, obj) { assertWritable(nome); return writeReq('POST', `/${nome}`, obj); }
async function updateRow(nome, id, obj) { assertWritable(nome); return writeReq('PATCH', `/${nome}?id=eq.${encodeURIComponent(id)}`, obj); }
async function deleteRow(nome, id) { assertWritable(nome); return writeReq('DELETE', `/${nome}?id=eq.${encodeURIComponent(id)}`); }

// Teste de conexão leve (usado pela tela de status do módulo).
async function ping() {
  if (!isConfigured()) return { configured: false, key_hint: keyHint(), url: BASE() || null };
  try {
    const tabelas = await listTables();
    return { configured: true, ok: true, total_tabelas: tabelas.length, key_hint: keyHint(), url: BASE() };
  } catch (e) {
    return { configured: true, ok: false, error: e.message, status: e.status || null, key_hint: keyHint(), url: BASE() };
  }
}

module.exports = { isConfigured, get, listTables, previewTable, selectRows, insertRow, updateRow, deleteRow, ping, keyHint };
