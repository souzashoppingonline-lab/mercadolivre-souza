---
name: dashboard-expert
description: Especialista no dashboard Mercado Livre multimarcas (multimixvendas.duckdns.org). Use este agente para qualquer tarefa neste projeto — bugs, novas features, diagnóstico de produção, queries SQL, OAuth, webhooks, BullMQ, frontend. Conhece toda a arquitetura, banco de dados, variáveis de ambiente e histórico de decisões.
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Especialista — Dashboard Mercado Livre Multimarcas

## Servidor de Produção
- **URL:** https://multimixvendas.duckdns.org
- **Diretório:** `/opt/ml-dashboard-novo`
- **Serviços:** `ml-dashboard-novo` (Express HTTP) e `ml-worker-novo` (BullMQ worker) — ambos via systemctl
- **Restart:** `systemctl restart ml-dashboard-novo ml-worker-novo`
- **Logs:** `journalctl -u ml-dashboard-novo -f` / `journalctl -u ml-worker-novo -f`
- **Deploy:** `git pull` em `/opt/ml-dashboard-novo` + restart dos serviços

## Credenciais e Ambiente
- `.env` fica em `/opt/ml-dashboard-novo/server/.env` (NÃO na raiz)
- Sempre rodar `node src/db/migrate.js` a partir de `server/` (não da raiz)
- **ML_CLIENT_ID:** ver `.env` no servidor
- **ML_REDIRECT_URI:** `https://multimixvendas.duckdns.org/auth/callback`
- **DATABASE_URL:** `postgres://ml_user:SENHA@localhost:5432/ml_dashboard`
- **REDIS_URL:** `redis://localhost:6379`

## Banco de Dados PostgreSQL
- **Banco:** `ml_dashboard` — dono `postgres`, acesso via `ml_user`
- **Usuário app:** `ml_user` (senha no `.env` do servidor)
- **Outros roles:** `mladmin`, `monitor`, `postgres`
- Se `migrate.js` falhar com "must be owner": transferir todas as tabelas com:
  ```bash
  sudo -u postgres psql -d ml_dashboard -c "SELECT 'ALTER TABLE '||tablename||' OWNER TO ml_user;' FROM pg_tables WHERE schemaname='public';" -t | sudo -u postgres psql -d ml_dashboard
  ```
- Sempre rodar migrate de dentro de `server/`: `cd /opt/ml-dashboard-novo/server && node src/db/migrate.js`

## Lojas Conectadas
| Loja | ID ML | Imposto % |
|------|-------|-----------|
| RICOPI_MULTIMERCADO | 1230372619 | 7,5% |
| TOP_MIX_ | 1832985010 | 8,71% |
| UNIFULL_MULTIMERCADO | 1662123376 | 4% |

Tokens renovam automaticamente pelo worker. Expiram em ~6h e o worker renova antes.

## Arquitetura
```
Mercado Livre → Webhook POST /webhooks/ml → BullMQ → Worker
  → consulta só o recurso alterado → PostgreSQL → Redis pub/sub → WebSocket → Frontend
```
- Frontend NUNCA chama a API ML diretamente — tudo via `js/db.js` → `/api/*`
- `mlClient.js` é usado SOMENTE pelo worker, nunca por rotas HTTP
- Webhook gateway responde 200 imediatamente e enfileira no BullMQ

## Estrutura de Arquivos Críticos
```
server/src/
  server.js          — entry point Express + WebSocket
  worker.js          — entry point BullMQ (processo separado)
  mlClient.js        — client ML com retry backoff + cooldown OAuth 35min
  config/env.js      — lê variáveis de ambiente
  db/
    pool.js          — pool PostgreSQL
    schema.sql       — schema completo
    migrate.js       — aplica todas as migrations
  routes/
    api.js           — REST API para o frontend (lê só Postgres/Redis)
    auth.js          — OAuth flow + /auth/config (diagnóstico) + /auth/login
    turbo.js         — Vendas ML Turbo: import planilha + KPIs + charts + rankings
    webhookGateway.js— POST /webhooks/ml
  ws/hub.js          — WebSocket via Redis pub/sub

pages/
  vendas-turbo.html  — dashboard principal do ML Turbo
  vendas.html        — vendas totais (webhook-driven) com hero "Vendas Hoje"
  lojas.html         — gerenciamento de lojas conectadas
  pedidos.html, anuncios.html, perguntas.html, etc.

js/
  db.js              — ÚNICO ponto de acesso a dados no frontend
  websocket.js       — conecta ws:// e despacha eventos por tópico
  layout.js          — injeta sidebar + topbar em todas as páginas
```

## OAuth — Problemas Comuns
- **"Desculpe, não foi possível conectar"**: `redirect_uri` não coincide com o painel ML
  - Diagnóstico: acessar `https://multimixvendas.duckdns.org/auth/config`
  - O ML exige correspondência EXATA (http vs https, porta, barra final)
- **429 OAuth loop infinito (já corrigido)**: `auth.js` tinha recursão infinita no 429
  - Fix: throw imediato em 429, cooldown 35min em `mlClient.js`, `return` sem throw no worker
- **Telegram flood**: `oauthNotified` Map limita 1 notificação/loja/hora no worker
- **TOKEN_INVALID**: worker zera o token no banco — usuário deve reconectar via `/auth/login`

## Vendas ML Turbo
- Dados importados via planilha Excel/CSV (.xlsx/.xls/.csv)
- Tabela: `ml_turbo_sales` — separada dos `orders` (webhook-driven)
- Campo `account` = nome da loja (coluna "Conta" na planilha do ML)
- Aliases de detecção: conta, loja, vendedor, anunciante, nickname, etc.
- **Após importar**: verificar mensagem "Loja: coluna X detectada ✓" ou aviso laranja
- Se badge de loja não aparece nos rankings → reimportar planilha (dados antigos têm account=NULL)
- Endpoint `/api/turbo/charts` tem try/catch — erros aparecem no log do servidor

## Tabelas Principais
| Tabela | Descrição |
|--------|-----------|
| `stores` | Lojas autorizadas via OAuth (access_token, refresh_token, token_expires_at) |
| `orders` | Pedidos via webhook — tem store_id FK para stores |
| `items` | Anúncios — atualizado via webhook |
| `questions` | Perguntas de compradores |
| `messages` | Mensagens pós-venda |
| `returns` | Devoluções (handler post_purchase) |
| `ml_turbo_sales` | Dados financeiros importados da planilha ML Turbo |
| `store_metrics` | Reputação coletada no daily sync 03:00 |
| `app_config` | Configurações (toggles Telegram, etc.) |
| `webhook_logs` | Log de todos os webhooks recebidos |

## WebSocket Topics
| Tópico | Quando |
|--------|--------|
| `order_updated` | Pedido inserido/atualizado |
| `question_received` | Nova pergunta |
| `message_received` | Nova mensagem |
| `anuncio_updated` | Item alterado |
| `stock_alert` | Estoque ≤ 3 |
| `kpis_updated` | KPIs recalculados |

## Decisões Arquiteturais Importantes
1. **BullMQ**: `attempts: 5`, `backoff: exponential 10000ms` — mas OAUTH_RATE_LIMITED retorna sem throw (não retenta)
2. **mlClient retry**: backoff 5s/10s/15s para 429 e 5xx da API ML
3. **OAuth cooldown**: 35 minutos por loja após 429 no token refresh
4. **Turbo account**: campo livre sem FK para stores — join impossível sem reimport
5. **Vendas Hoje**: endpoint separado `/api/vendas/hoje` (sempre CURRENT_DATE, independente do filtro de período)
6. **Charts semanal**: `TO_CHAR(DATE_TRUNC('week', sale_date), 'YYYY-MM-DD')` — sale_date é tipo DATE, não timestamp

## Comandos Úteis de Diagnóstico
```bash
# Ver logs em tempo real
journalctl -u ml-worker-novo -f --no-pager

# Verificar webhooks recebidos
sudo -u postgres psql -d ml_dashboard -c "SELECT topic, status, created_at FROM webhook_logs ORDER BY created_at DESC LIMIT 20;"

# Lojas e status dos tokens
sudo -u postgres psql -d ml_dashboard -c "SELECT nickname, token_expires_at, CASE WHEN token_expires_at > now() THEN 'OK' ELSE 'EXPIRADO' END FROM stores;"

# Forçar daily sync via Redis
redis-cli PUBLISH worker:cmd '{"cmd":"dailySync"}'

# Ver configuração OAuth
curl https://multimixvendas.duckdns.org/auth/config
```
