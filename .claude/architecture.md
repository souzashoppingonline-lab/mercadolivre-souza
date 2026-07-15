# Arquitetura

> Escopo deste arquivo: visão geral do sistema, fluxo de dados ponta-a-ponta, topologia de processos e a árvore de diretórios. Detalhes de cada camada vivem em arquivos próprios (ver tabela em `CLAUDE.md`).

## Padrão: Event-Driven Architecture (EDA)

O sistema nunca deixa o frontend consultar a API do Mercado Livre. Tudo passa por um pipeline assíncrono orientado a eventos:

```
Mercado Livre → Webhook → Webhook Gateway → BullMQ → Worker
  → consulta SOMENTE o recurso alterado na API do ML
  → grava em PostgreSQL
  → invalida cache Redis
  → publica evento no Redis pub/sub
  → WebSocket hub reenvia para os browsers conectados
  → páginas do dashboard atualizam em tempo real
```

Motivo dessa escolha: o ML notifica só que "o recurso X mudou" (webhook enxuto, sem payload completo). O worker busca o dado completo daquele recurso específico — nunca faz varreduras completas da conta a cada evento. Isso mantém o volume de chamadas à API do ML proporcional ao volume de eventos reais, não ao tamanho do catálogo/histórico.

## Dois processos independentes

O backend roda como **dois processos Node.js separados**, cada um com seu próprio ciclo de vida (dois serviços systemd em produção — ver `deployment.md`):

| Processo | Entry point | Responsabilidade |
|---|---|---|
| HTTP server | `server/src/server.js` | Express: REST API (`/api`), Webhook Gateway (`/webhooks`), OAuth (`/auth`, `/ml`), WebSocket (`/ws`) |
| Worker | `server/src/worker.js` | Consome filas BullMQ, fala com a API do ML, grava no Postgres, publica eventos, roda os syncs agendados |

Os dois processos se comunicam **apenas via Redis** (filas BullMQ + pub/sub), nunca por chamada direta. Isso permite escalar/reiniciar cada um independentemente.

## Regras de fronteira (não violar)

1. O frontend (`/index.html`, `/pages/*.html`) só fala com `/api/*` (REST) e `/ws` (WebSocket). Nunca chama `api.mercadolibre.com` diretamente.
2. `server/src/mlClient.js` (cliente da API do ML) só pode ser importado por `worker.js` ou por rotas que executam ações pontuais autorizadas pelo usuário (ex.: responder pergunta em `routes/api.js`, `routes/webhookGateway.js` para replies do Telegram). Rotas de **leitura** do dashboard nunca chamam `mlClient`.
3. `routes/api.js` só lê Postgres/Redis — não faz chamadas HTTP externas para popular listagens.
4. `routes/webhookGateway.js` responde `200` imediatamente e enfileira o processamento — nunca faz trabalho síncrono pesado na requisição do webhook.
5. O pipeline de eventos de outros marketplaces (`marketplaceEventWorker.js`, fila `marketplace-events-*`) é desacoplado do dispatch table ML (`handlers`/`processJob` em `worker.js`) — um nunca chama o outro. Ver `workers.md` ("Eventos de outros marketplaces") e `decisions.md` ("Marketplace Engine — schema evolutivo").
6. A Agenda Trello (`taskEngine.js`, `routes/tasks.js`, `pages/agenda-trello.html`) é um módulo independente: tabela própria (`tasks`/`task_comments`), sem FK para `orders`/`items`, sem alterar nenhuma rota/página ML existente. Toda regra de criação automática de cartão vive em `taskEngine.js` — nunca em `worker.js` diretamente nem nas páginas. Ver `task-engine.md`.
7. Estático (`index.html`, `css/`, `js/`, `pages/`, `assets/`) é servido pelo próprio Express (`express.static` em `server.js`), não mais diretamente pelo nginx — necessário pra que o gate de autenticação (`requireStaffAuth`) proteja o carregamento de página, não só `/api/*`. O nginx só faz `proxy_pass` para o Node em `location /` (mesmo padrão que já usava para `/api`, `/webhooks` etc.). Ver `auth-staff.md`.

## Estrutura de diretórios

```
/                     ← Frontend estático (HTML/CSS/JS, sem build step)
  index.html          ← Dashboard principal
  pages/               ← ~29 páginas (anuncios, pedidos, vendas, etc. — ver frontend.md)
  css/                 ← style.css, sidebar.css, cards.css
  js/
    db.js              ← único ponto de acesso a dados no frontend (chama /api/*)
    websocket.js        ← cliente WS, reconexão automática, heartbeat
    layout.js           ← injeta sidebar + topbar, seletor de loja, alertas sonoros/visuais
    sidebar.js           ← toggle mobile/desktop da sidebar
    dashboard.js          ← lógica do index.html
    webhook.js             ← lógica da página pages/webhook.html
    api.js                  ← legado, NÃO USAR em páginas novas (referência da API ML crua)

server/                ← Backend Node.js (dois processos — ver acima)
  src/
    server.js           ← entry point HTTP
    worker.js             ← entry point worker BullMQ (pipeline ML — intocado desde v15)
    marketplaceEventWorker.js  ← v15: entry point (chamado por worker.js) do worker de eventos
                                   de outros marketplaces — fila/dispatch separados do ML
    mlClient.js            ← cliente HTTP da API do ML — uso restrito (ver regra 2)
    taskEngine.js            ← v19: Agenda Trello — regras de geração automática de cartões (ver task-engine.md)
    config/env.js           ← leitura de variáveis de ambiente
    db/
      pool.js               ← pool de conexões PostgreSQL (pg)
      redis.js                ← cliente ioredis compartilhado
      schema.sql                ← schema base
      migrate-v2.sql … v15.sql   ← migrations incrementais
      migrate.js                  ← aplica schema + migrations em sequência
    queues/
      webhookQueue.js            ← fábrica de filas BullMQ por loja (ML)
      marketplaceEventQueue.js     ← v15: fábrica de filas BullMQ por marketplace (`marketplace-events-{code}`)
    marketplaces/                ← "Marketplace Engine" — camada comum multi-marketplace
      interfaces/MarketplaceClient.js  ← contrato (refreshAccessToken, getOrder, listRecentOrders)
      interfaces/EventSource.js          ← v15: contrato (start, stop, discoverEvents)
      Scheduler.js                         ← v15: orquestra EventSources no intervalo registrado
      base/errors.js                    ← erros compartilhados (RateLimit, TokenInvalid, Transient)
      mercadolivre/                       ← reservado, vazio — ML continua em mlClient.js/routes/auth.js
      amazon/amazonClient.js                ← cliente SP-API (LWA + Orders API)
      amazon/AmazonPollingEventSource.js      ← v15: EventSource real — polling 15min, publica em marketplaceEventQueue
      shopee/shopeeClient.js                  ← stub — app em aprovação (ver shopee.md)
    routes/
      api.js                      ← REST API consumida pelo frontend
      auth.js                       ← OAuth (login, callback, refresh de token)
      turbo.js                       ← upload/consulta da planilha Vendas ML Turbo
      webhookGateway.js               ← POST /webhooks/ml e /webhooks/telegram
      tasks.js                          ← v19: /api/tasks/* — Agenda Trello (ver task-engine.md)
    ws/
      hub.js                          ← WebSocket + Redis pub/sub
  nginx-websocket.conf              ← config de proxy para manter WS vivo
  sync-now.sh                        ← dispara dailySync manualmente via Redis
  test-ads.js                         ← script exploratório de endpoints de Publicidade ML

.claude/                ← Esta documentação modular (ver CLAUDE.md)
```

## Por que multi-loja com filas separadas

Cada loja (`store_id`) tem sua própria fila BullMQ (`ml-webhooks-{storeId}`) e seu próprio worker com `concurrency: 3` e `limiter: 3 req/3s`. Isso isola o rate limit de uma loja das demais — se uma loja atinge 429 na API do ML, as outras continuam processando normalmente. Detalhes de implementação em `workers.md`.
