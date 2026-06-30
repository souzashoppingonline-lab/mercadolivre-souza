# ML Dashboard — Backend (Event-Driven Architecture)

Fluxo obrigatório:

```
Mercado Livre → Webhook → Webhook Gateway → BullMQ → Worker
  → consulta somente o recurso alterado → atualiza PostgreSQL
  → atualiza Redis → atualiza Dashboard via WebSocket
```

O frontend (`/index.html`, `/pages/*.html`) nunca chama a API do Mercado
Livre diretamente. Ele só conversa com `/api/*` (REST, lê do Postgres/Redis)
e `/ws` (WebSocket, recebe push do worker).

## Setup

```bash
cd server
cp .env.example .env   # preencha DATABASE_URL, REDIS_URL, credenciais ML e Telegram
npm install
npm run migrate         # cria as tabelas no Postgres
```

## Rodar

Em dois processos separados (idealmente dois serviços systemd):

```bash
npm start    # HTTP server: REST API (/api) + Webhook Gateway (/webhooks/ml) + WebSocket (/ws)
npm run worker  # BullMQ worker: processa os jobs enfileirados pelo gateway
```

## Configurar o Webhook no Mercado Livre

Aponte a callback URL da sua aplicação ML para:

```
https://SEU_DOMINIO/webhooks/ml
```

Tópicos recomendados: `orders_v2`, `questions`, `messages`, `items`, `payments`.

## Transição do sistema antigo

Enquanto este backend não estiver validado em produção (Postgres populado,
worker estável, WebSocket entregando eventos), **mantenha o serviço antigo
(`ml-dashboard.service`) rodando**. Ele continua sendo a fonte de dados real
até a migração ser concluída. Desligue-o somente depois de confirmar que:

1. O webhook do ML está apontando para `/webhooks/ml` deste backend.
2. O worker está processando os jobs sem erros (`webhook_logs.status = 'processed'`).
3. As páginas do dashboard novo exibem dados reais vindos do Postgres.
