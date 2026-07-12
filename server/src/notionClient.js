// Notion API client — cria tarefas no Notion a partir de dados do dashboard.
// Requer NOTION_TOKEN (Integration token) e NOTION_DATABASE_ID (ID do database
// "Minhas Tarefas") configurados no .env.

const env = require('./config/env');

const BASE = 'https://api.notion.com/v1';
const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;

function notionHeaders() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

async function notionRequest(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: notionHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Notion API ${path} → ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

// Cria uma página (tarefa) no database configurado.
// props: { title, prazo (Date), prioridade ('Alta'|'Média'|'Baixa'), fonte }
async function criarTarefa({ title, prazo, prioridade = 'Média', fonte = 'ML Dashboard', content = '' }) {
  if (!TOKEN) throw new Error('NOTION_TOKEN não configurado no .env');
  if (!DB_ID) throw new Error('NOTION_DATABASE_ID não configurado no .env');

  const properties = {
    'Nome da tarefa': { title: [{ text: { content: title } }] },
    'Status':         { status: { name: 'To-do' } },
  };

  if (prazo) {
    properties['Prazo'] = { date: { start: prazo } };
  }

  // Tenta setar "Fonte" — pode ser select ou rich_text. Tenta como rich_text.
  try {
    properties['Fonte'] = { rich_text: [{ text: { content: fonte } }] };
  } catch {}

  const body = {
    parent: { database_id: DB_ID },
    properties,
  };

  if (content) {
    body.children = [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content } }],
        },
      },
    ];
  }

  return notionRequest('POST', '/pages', body);
}

// Busca tarefas com título semelhante para evitar duplicatas.
async function buscarTarefaExistente(tituloFiltro) {
  if (!TOKEN || !DB_ID) return null;
  try {
    const res = await notionRequest('POST', `/databases/${DB_ID}/query`, {
      filter: {
        property: 'Nome da tarefa',
        title: { contains: tituloFiltro },
      },
      page_size: 1,
    });
    return res.results?.[0] || null;
  } catch {
    return null;
  }
}

module.exports = { criarTarefa, buscarTarefaExistente, isConfigured: () => !!(TOKEN && DB_ID) };
