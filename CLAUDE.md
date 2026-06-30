# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack Mercado Livre seller dashboard using an **event-driven architecture (EDA)**. The frontend never calls the Mercado Livre API directly — all data flows through webhooks.

```
Mercado Livre → Webhook → Gateway → BullMQ → Worker
  → consulta só o recurso alterado → PostgreSQL → Redis → WebSocket → Dashboard
```

## Repository Structure

```
/                     ← Frontend (static HTML/CSS/JS)
  index.html          ← Dashboard principal
  pages/              ← 24 páginas (anuncios, pedidos, vendas, etc.)
  css/                ← style.css, sidebar.css, cards.css
  js/
    db.js             ← ÚNICO ponto de acesso a dados no frontend (chama /api/*)
    websocket.js      ← Conecta em ws://HOST/ws e despacha eventos por tópico
    layout.js         ← Injeta sidebar + topbar em todas as páginas
    api.js            ← NÃO USAR nas páginas — mantido só como referência da API ML
    dashboard.js      ← Lógica do index.html

server/               ← Backend Node.js
  src/
    server.js         ← Entry point: Express + WebSocket attach
    worker.js         ← Entry point: BullMQ worker (processo separado)
    mlClient.js       ← Client ML — usado SOMENTE pelos workers
    config/env.js     ← Lê variáveis de ambiente
    db/
      pool.js         ← Pool PostgreSQL (pg)
      redis.js        ← Cliente ioredis
      schema.sql      ← Schema completo (stores, items, orders, questions, etc.)
      migrate.js      ← Aplica schema.sql no banco
    queues/
      webhookQueue.js ← Fila BullMQ "ml-webhooks"
    routes/
      api.js          ← REST API consumida pelo frontend (lê só Postgres/Redis)
      webhookGateway.js ← POST /webhooks/ml — recebe do ML, enfileira, ack rápido
    ws/
      hub.js          ← WebSocket hub via Redis pub/sub (server + worker se comunicam)
```

## Backend Commands

```bash
cd server
cp .env.example .env      # preencher variáveis
npm install
npm run migrate           # cria/atualiza tabelas no PostgreSQL
npm start                 # inicia HTTP server (porta 3000 por padrão)
npm run worker            # inicia BullMQ worker (processo separado)
```

## Environment Variables (server/.env)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/ml_dashboard` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ML_CLIENT_ID` | App ID do Mercado Livre |
| `ML_CLIENT_SECRET` | App Secret do Mercado Livre |
| `TELEGRAM_BOT_TOKEN` | Token do bot para notificações |
| `TELEGRAM_CHAT_ID` | Chat ID para notificações |
| `PORT` | Porta HTTP (padrão: 3000) |

## Frontend Configuration

O frontend usa dois valores do `localStorage`:

| Chave | Padrão | Descrição |
|---|---|---|
| `ml_backend_url` | `http://localhost:3000/api` | URL base da REST API |
| `ml_ws_url` | `ws://localhost:3000/ws` | URL do WebSocket |

## Architectural Rules

1. **Nenhuma página HTML pode chamar a API do Mercado Livre diretamente.** Todo acesso a dados passa por `js/db.js` → `/api/*` → PostgreSQL/Redis.
2. **`js/api.js` não deve ser importado em páginas novas.** Existe só como referência histórica da API ML.
3. **`server/src/mlClient.js` só é chamado de dentro de `worker.js`**, nunca de rotas HTTP.
4. **O Webhook Gateway (/webhooks/ml) responde 200 imediatamente** e só depois processa. Nunca adicionar lógica síncrona lenta nessa rota.
5. **Invalidação de cache Redis:** sempre que um worker atualizar uma tabela, deletar a chave de cache correspondente (ex: `redis.del('kpis:' + storeId)`).

## WebSocket Topics

Tópicos publicados pelo worker via `ws/hub.js` e consumidos pelas páginas via `js/websocket.js`:

| Tópico | Disparado quando |
|---|---|
| `order_updated` | Pedido inserido/atualizado |
| `question_received` | Nova pergunta ou resposta |
| `message_received` | Nova mensagem de comprador |
| `anuncio_updated` | Item/anúncio alterado |
| `stock_alert` | Estoque ≤ 3 unidades |
| `webhook_received` | Qualquer webhook chegou no gateway |
| `kpis_updated` | KPIs recalculados |

## Adding a New Page

1. Copie a estrutura de uma página existente (ex: `pages/pedidos.html`).
2. Defina `window.PAGE_TITLE` e `window.ACTIVE_NAV` antes de incluir `layout.js`.
3. Use apenas `DB.*` para buscar dados — nunca `ML_API.*` ou `fetch` direto para a API ML.
4. Registre um listener `WS.on('topic', handler)` para atualizar a página em tempo real.
5. Adicione o link na lista `NAV_ITEMS` em `js/layout.js`.

## Key Files to Read First

- `server/src/worker.js` — entender como cada tópico de webhook vira dado no Postgres
- `server/src/routes/api.js` — todos os endpoints REST disponíveis para o frontend
- `js/db.js` — todas as funções que o frontend pode chamar
- `server/src/db/schema.sql` — estrutura completa das tabelas

## Transição do Sistema Antigo

O serviço `ml-dashboard.service` (Node.js em `/src/server.js` do repositório `servidorlinux`) ainda está rodando em produção e é a fonte de dados real. Só desativá-lo depois que:
1. O webhook do ML estiver apontando para `https://DOMINIO/webhooks/ml` (novo backend).
2. A tabela `webhook_logs` mostrar `status = 'processed'` consistentemente.
3. As páginas do dashboard exibirem dados reais vindos do PostgreSQL.
