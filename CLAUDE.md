# ML Dashboard — Contexto do Projeto para Claude

Este arquivo garante que qualquer sessão do Claude Code saiba exatamente
o estado atual do projeto, o que foi implementado e o que falta.

---

## O que é este projeto

Dashboard de gestão para Mercado Livre.
Arquitetura orientada a eventos: ML Webhook → BullMQ → Worker → PostgreSQL + Redis → WebSocket → Frontend.
Nenhuma página consulta a API do ML diretamente. Jamais.

---

## Branches

- Branch de trabalho: `claude/project-status-axs1rd`
- Branch de arquivo anterior: `claude/archive-files-git-8vn8pv`
- Branch principal: `main`

---

## Estado atual (última atualização: 2026-06-30)

### ✅ Concluído e pronto para testes

**Backend (`server/src/`)**
- `server.js` — Express + WebSocket + rotas
- `routes/webhookGateway.js` — recebe ML webhook, ack 200 imediato, enfileira BullMQ
- `routes/api.js` — REST API completa (25+ endpoints), lê PG/Redis, nunca chama ML
- `worker.js` — processa jobs: orders, questions, messages, items; corrigido cache key + emite kpis_updated
- `ws/hub.js` — Redis pub/sub para WebSocket entre processos
- `mlClient.js` — chamado SOMENTE pelo worker
- `queues/webhookQueue.js` — fila BullMQ
- `db/schema.sql` — schema completo com tabelas: stores, items, orders, questions, messages, returns, ads_campaigns, webhook_logs, schedule_jobs
- `db/migrate.js` — runner de migração
- `config/env.js` — configuração de variáveis
- `.env.example` — modelo completo

**Frontend (`js/`, `css/`, `index.html`, `pages/`)**
- `js/db.js` — cliente REST para `/api/*` (todos os métodos implementados)
- `js/websocket.js` — cliente WS com reconexão automática e backoff
- `js/dashboard.js` — CORRIGIDO: conectado à API real + WebSocket (era mock)
- `js/layout.js` — sidebar e topbar injetados dinamicamente
- `index.html` — CORRIGIDO: inclui db.js e websocket.js
- 25 páginas em `pages/` — todas conectadas ao DB e WebSocket

**Documentação e infraestrutura**
- `install.sh` — script de instalação automatizada (chmod +x)
- `README.md` — documentação completa com checklist de testes

---

## Bugs corrigidos nesta sessão

| Bug | Arquivo | Correção |
|---|---|---|
| Cache key errada | `worker.js` | `kpis:${storeId}` → `kpis:summary` |
| `kpis_updated` nunca emitido | `worker.js` | Adicionado `publish('kpis_updated', {})` nos handlers |
| `dashboard.js` usava mock | `js/dashboard.js` | Reescrito usando `DB.*` e `WS.on()` |
| `websocket.js` ausente no index | `index.html` | Adicionados `db.js` e `websocket.js` |
| Endpoints faltando na API | `routes/api.js` | 15+ endpoints adicionados (clientes, lojas, metricas, analises, comparativos, alertas, publicidade...) |
| `questions` sem `item_title` | `schema.sql` + `worker.js` | Coluna adicionada ao schema e populada no worker |
| Summaries incompletos | `routes/api.js` | Campos reais: total_hoje, aguardando_envio, answered_today, etc. |

---

## O que ainda NÃO está implementado (próximas sessões)

| Item | Prioridade | Detalhes |
|---|---|---|
| Scheduler autônomo | Alta | `syncInventory`, `syncVisits`, `syncPerformance`, `refreshToken` — jobs registrados no banco mas sem processo que os executa |
| OAuth / Auth flow | Alta | Sem rota de login/callback OAuth — token precisa ser inserido manualmente no banco |
| Telegram notifications | Média | `TELEGRAM_BOT_TOKEN` está no `.env` mas não há código de envio |
| `concorrentes.html` | Baixa | API retorna array vazio — precisa de scheduler |
| `publicidade.html` | Baixa | Dados virão de scheduler `syncAds` — tabela existe mas sem dados |
| Handler `claims` no worker | Média | Sem handler para tópico `claims` (reclamações) |
| Testes automatizados | Alta | Nenhum teste unitário ou de integração |

---

## Arquitetura de arquivos — O que cada arquivo faz

```
server/src/
  server.js             → Entry point. Liga Express, monta rotas, ativa WebSocket.
  worker.js             → Processo separado. Consome BullMQ, chama ML API, grava PG, emite WS.
  mlClient.js           → Wrapper da API do ML. SOMENTE usado pelo worker.
  config/env.js         → Lê process.env e exporta objeto tipado.
  db/pool.js            → Pool pg para PostgreSQL.
  db/redis.js           → Cliente ioredis compartilhado.
  db/schema.sql         → DDL completo (tabelas + índices).
  db/migrate.js         → Executa schema.sql no banco.
  queues/webhookQueue.js → Define a fila BullMQ 'ml-webhooks'.
  routes/api.js         → Todos os endpoints REST do frontend.
  routes/webhookGateway.js → Recebe POST /webhooks/ml do ML.
  ws/hub.js             → WebSocket server + Redis pub/sub broadcaster.

js/
  db.js        → Chama /api/* do backend. NÃO chama ML diretamente.
  websocket.js → Conecta ws://localhost:3000/ws, reconecta, despacha eventos.
  dashboard.js → Lógica da index.html — usa DB.* e WS.on().
  layout.js    → Injeta sidebar/topbar nas páginas de /pages/.
  sidebar.js   → Toggle de sidebar.
  api.js       → LEGADO: cliente direto da API do ML. NÃO está sendo usado.
                  Não deletar — pode ser necessário para auth flow futuro.
```

---

## Como rodar localmente para testar

```bash
# Pré-requisitos: PostgreSQL e Redis rodando
cd server
cp .env.example .env   # editar com suas credenciais
node src/db/migrate.js # aplica schema

# Terminal 1
npm start              # http://localhost:3000

# Terminal 2
npm run worker         # processa jobs BullMQ
```

Abrir `index.html` no browser (ou servir com `npx serve .` na raiz).

---

## Como testar webhook manualmente

```bash
curl -X POST http://localhost:3000/webhooks/ml \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "orders_v2",
    "resource": "/orders/123456789",
    "user_id": SEU_STORE_ID,
    "application_id": 0
  }'
# Deve retornar HTTP 200 imediatamente
# Worker processa em background e emite WebSocket
```

---

## Convenções do projeto

- Sem chamadas ML no frontend — nunca
- Sem chamadas ML nas rotas `/api/` — nunca
- ML é chamado SOMENTE em `server.js/worker.js` via `mlClient.js`
- Cache Redis: chave padrão `kpis:summary`, TTL 30s
- Eventos WebSocket: snake_case (`order_updated`, `kpis_updated`, ...)
- Todos os endpoints retornam JSON com campos `results`/`items` + `summary`
