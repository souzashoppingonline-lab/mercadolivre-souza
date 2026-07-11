# Backend — Servidor HTTP

> Escopo: o processo Express (`server/src/server.js`), configuração, dependências e como as rotas são montadas. Para o conteúdo de cada endpoint ver `api.md`. Para o worker BullMQ ver `workers.md`. Para schema ver `database.md`.

## Entry point — `server/src/server.js`

```js
app.use('/api', apiRoutes);          // routes/api.js
app.use('/api/turbo', turboRoutes);  // routes/turbo.js
app.use('/webhooks', webhookGateway);// routes/webhookGateway.js
app.use('/auth', authRoutes);        // routes/auth.js
app.use('/ml', authRoutes);          // mesmo router — ML app tem /ml/callback configurado
app.get('/health', ...)
wsHub.attach(server);                // upgrade de conexão em /ws
```

Middlewares globais: `cors()` (sem allowlist — aberto) e `express.json()`.

`server.keepAliveTimeout = 3600000` e `server.headersTimeout = 3601000` — ajustados para suportar a conexão WebSocket e o endpoint SSE de logs (`/api/schedule/worker-logs`) por longos períodos sem timeout do lado Node.

## Configuração — `server/src/config/env.js`

Lê `.env` via `dotenv` e centraliza acesso a variáveis de ambiente:

```js
{
  port, databaseUrl, redisUrl,
  ml: { clientId, clientSecret, redirectUri, webhookSecret },
  telegram: { botToken, chatId },
  anthropicApiKey,
}
```

Nenhum outro módulo deve ler `process.env` diretamente fora de `config/env.js` — exceção: `worker.js` usa `process.env.DASH_URL` e `process.env.TELEGRAM_BOT_TOKEN` como fallback em alguns pontos legados.

Variáveis (ver `server/.env.example`):

| Variável | Uso |
|---|---|
| `PORT` | porta HTTP (padrão 3000) |
| `DATABASE_URL` | string de conexão Postgres |
| `REDIS_URL` | string de conexão Redis |
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` / `ML_REDIRECT_URI` | credenciais OAuth padrão (lojas podem sobrescrever com credenciais próprias — ver `mercadolivre.md`) |
| `ML_WEBHOOK_SECRET` | reservado para validação de assinatura do webhook (não usado atualmente no código) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | fallback quando não há config em `app_config` (ver `database.md`) |
| `ANTHROPIC_API_KEY` | habilita o endpoint `POST /api/mcp/chat` (assistente de IA) |
| `DASH_URL` (não documentada no `.env.example`) | usada pelo worker para montar links de dashboard nas notificações Telegram; padrão `https://multimixvendas.duckdns.org` |

## Dependências (`server/package.json`)

| Pacote | Papel |
|---|---|
| `express` | servidor HTTP e roteamento |
| `bullmq` + `ioredis` | filas de jobs e cliente Redis |
| `pg` | driver PostgreSQL |
| `ws` | servidor WebSocket |
| `multer` | upload de planilha (`routes/turbo.js`) |
| `xlsx` | parsing de planilha Excel/CSV |
| `node-fetch` | chamadas HTTP para API do ML, Telegram e Anthropic |
| `cors`, `dotenv` | infraestrutura básica |

Scripts:
```bash
npm start     # node src/server.js
npm run worker  # node src/worker.js
npm run migrate # node src/db/migrate.js
```

## Conexões compartilhadas

- `db/pool.js` — instancia `new Pool({ connectionString: env.databaseUrl })` uma única vez, exportado como singleton. Todo módulo que precisa do Postgres importa este arquivo (nunca cria seu próprio `Pool`).
- `db/redis.js` — instancia `new Redis(env.redisUrl)` uma única vez, singleton exportado. Usado para cache (`api.js`), pub/sub (`ws/hub.js`, via `.duplicate()`) e canal de comandos (`worker:cmd`).

## Diagnóstico rápido

- `GET /health` → `{ ok: true }` (liveness check simples, sem checar Postgres/Redis).
- `GET /auth/config` → mostra `client_id`/`redirect_uri` configurados (não expõe o secret) para depurar problemas de OAuth — ver `mercadolivre.md`.
