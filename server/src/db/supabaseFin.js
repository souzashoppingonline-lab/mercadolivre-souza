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
  return { apikey: KEY(), Authorization: `Bearer ${KEY()}` };
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

// Lista as tabelas/views expostas (lê o schema OpenAPI da raiz do PostgREST).
async function listTables() {
  const spec = await get('/');
  const defs = spec?.definitions || spec?.components?.schemas || {};
  return Object.keys(defs).sort();
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

// Teste de conexão leve (usado pela tela de status do módulo).
async function ping() {
  if (!isConfigured()) return { configured: false };
  try {
    const tabelas = await listTables();
    return { configured: true, ok: true, total_tabelas: tabelas.length };
  } catch (e) {
    return { configured: true, ok: false, error: e.message, status: e.status || null };
  }
}

module.exports = { isConfigured, get, listTables, previewTable, ping };
