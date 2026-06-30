# ML Dashboard

Dashboard de gestão para Mercado Livre com arquitetura orientada a eventos.
Sem polling. Sem rate limit. Atualização em tempo real via WebSocket.

---

## Índice

1. [Por que esta arquitetura?](#1-por-que-esta-arquitetura)
2. [Visão geral da arquitetura](#2-visão-geral-da-arquitetura)
3. [Fluxo completo de dados](#3-fluxo-completo-de-dados)
4. [Redis — papel central no sistema](#4-redis--papel-central-no-sistema)
5. [PostgreSQL — fonte única da verdade](#5-postgresql--fonte-única-da-verdade)
6. [WebSocket — atualização em tempo real](#6-websocket--atualização-em-tempo-real)
7. [BullMQ — fila de jobs](#7-bullmq--fila-de-jobs)
8. [Docker — ambiente de desenvolvimento](#8-docker--ambiente-de-desenvolvimento)
9. [Instalação sem Docker](#9-instalação-sem-docker)
10. [Variáveis de ambiente](#10-variáveis-de-ambiente)
11. [Inicialização](#11-inicialização)
12. [Estrutura de arquivos](#12-estrutura-de-arquivos)
13. [Banco de dados — tabelas e schema](#13-banco-de-dados--tabelas-e-schema)
14. [API REST — referência completa](#14-api-rest--referência-completa)
15. [Scheduler — sincronização inteligente](#15-scheduler--sincronização-inteligente)
16. [Configurar Webhook no Mercado Livre](#16-configurar-webhook-no-mercado-livre)
17. [Checklist de testes](#17-checklist-de-testes)
18. [Problemas comuns](#18-problemas-comuns)

---

## 1. Por que esta arquitetura?

O Mercado Livre possui limites de chamadas à API (rate limit) que se tornam
um problema sério quando o sistema cresce — múltiplas lojas, múltiplas páginas,
múltiplos usuários consultando dados ao mesmo tempo.

A solução adotada neste projeto elimina esse problema na raiz:

| Abordagem tradicional | Esta arquitetura |
|---|---|
| Cada página chama a API do ML | Nenhuma página chama a API do ML |
| Polling a cada X minutos | Webhook push imediato do ML |
| Rate limit constante | Redução de 95%+ das chamadas |
| Dados desatualizados entre polls | Atualização em tempo real via WebSocket |
| Lento — espera resposta da API | Instantâneo — lê do banco local |

**A regra absoluta deste sistema:**
> Nenhuma página do frontend consulta a API do Mercado Livre. Jamais.
> Toda leitura vem do PostgreSQL (via REST API local) ou do Redis (cache).
> Toda escrita começa por um Webhook do ML, processado de forma assíncrona.

---

## 2. Visão geral da arquitetura

```
╔══════════════════════════════════════════════════════════════════╗
║                        MERCADO LIVRE                             ║
║                                                                  ║
║  Evento ocorre (novo pedido, pergunta, item alterado...)         ║
║  ML envia Webhook POST para /webhooks/ml                        ║
╚══════════════════════════════════════════════╦═══════════════════╝
                                               │ HTTP POST
                                               ▼
╔══════════════════════════════════════════════════════════════════╗
║                      NODE.JS SERVER (server.js)                  ║
║                                                                  ║
║  ┌─────────────────────┐    ┌──────────────────────────────────┐ ║
║  │  Webhook Gateway    │    │       REST API (/api/*)          │ ║
║  │  POST /webhooks/ml  │    │                                  │ ║
║  │                     │    │  Lê PostgreSQL + Redis Cache     │ ║
║  │  1. Ack 200 imediato│    │  Nunca chama a API do ML         │ ║
║  │  2. Grava log no PG │    │                                  │ ║
║  │  3. Enfileira BullMQ│    └──────────────────────────────────┘ ║
║  └──────────┬──────────┘                                         ║
║             │                  ┌────────────────────────────────┐ ║
║             │                  │    WebSocket Hub (/ws)         │ ║
║             │                  │                                │ ║
║             │                  │  Redis pub/sub broadcaster     │ ║
║             │                  │  Envia eventos para o browser  │ ║
║             │                  └────────────────────────────────┘ ║
╚═════════════╬════════════════════════════════════════════════════╝
              │
╔═════════════╩════════════════════════════════════════════════════╗
║                       REDIS (3 funções)                          ║
║                                                                  ║
║  ┌──────────────────┐  ┌───────────────┐  ┌───────────────────┐ ║
║  │  Fila BullMQ     │  │  Cache        │  │  Pub/Sub          │ ║
║  │  (jobs pendentes)│  │  (KPIs, listas│  │  (notifica WS hub)│ ║
║  │                  │  │   em memória) │  │                   │ ║
║  └──────────────────┘  └───────────────┘  └───────────────────┘ ║
╚═════════════╬════════════════════════════════════════════════════╝
              │ consome jobs
╔═════════════╩════════════════════════════════════════════════════╗
║                    BULLMQ WORKER (worker.js)                     ║
║                    (processo separado do server)                 ║
║                                                                  ║
║  Para cada job:                                                  ║
║  1. Busca recurso alterado na API do ML (1 chamada cirúrgica)   ║
║  2. Grava/atualiza no PostgreSQL                                ║
║  3. Invalida cache Redis (kpis:summary, etc.)                   ║
║  4. Publica evento no canal Redis pub/sub                       ║
║  5. WebSocket Hub recebe e broadcast para todos os browsers      ║
╚═════════════╬════════════════════════════════════════════════════╝
              │
╔═════════════╩════════════════════════════════════════════════════╗
║                      POSTGRESQL                                  ║
║                  (fonte única da verdade)                        ║
║                                                                  ║
║  stores · items · orders · questions · messages                  ║
║  returns · ads_campaigns · webhook_logs · schedule_jobs          ║
╚══════════════════════════════════════════════════════════════════╝
              │
              │ REST API + WebSocket push
              ▼
╔══════════════════════════════════════════════════════════════════╗
║                     FRONTEND (browser)                           ║
║                                                                  ║
║  25 páginas — todas recebem dados via:                          ║
║  • GET /api/* ao carregar (lê do PG via REST)                   ║
║  • WebSocket events ao vivo (atualiza sem reload)               ║
║                                                                  ║
║  Dashboard · Pedidos · Vendas · Anúncios · Perguntas            ║
║  Mensagens · Clientes · Métricas · Horários · Curva ABC ...     ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 3. Fluxo completo de dados

### Quando chega um pedido novo

```
1.  ML detecta novo pedido e envia:
    POST /webhooks/ml
    { "topic": "orders_v2", "resource": "/orders/123456", "user_id": 987 }

2.  webhookGateway.js responde HTTP 200 em < 1ms
    (o ML exige resposta rápida ou vai reenviar)

3.  Job enfileirado no Redis (BullMQ):
    { topic: "orders_v2", resource: "/orders/123456", storeId: 987, logId: 42 }

4.  worker.js consome o job:
    a. Busca GET https://api.mercadolibre.com/orders/123456
       (com o access_token da store 987, buscado no PostgreSQL)
    b. Faz UPSERT na tabela orders do PostgreSQL
    c. Invalida chave "kpis:summary" no Redis Cache
    d. Publica no canal Redis "ml:ws:broadcast":
       { topic: "order_updated", payload: { id: 123456, status: "paid" } }
       { topic: "kpis_updated",  payload: {} }

5.  ws/hub.js recebe do canal Redis e envia para TODOS os browsers conectados

6.  No browser, websocket.js recebe o evento:
    WS.on("order_updated", () => recarregar tabela de pedidos)
    WS.on("kpis_updated",  () => atualizar KPIs do dashboard)

7.  Próxima leitura do dashboard chama GET /api/dashboard/kpis
    → API tenta Redis (cache miss porque foi invalidado)
    → Busca no PostgreSQL, recalcula, armazena no Redis por 30s
    → Retorna dados atualizados
```

### Quando o dashboard carrega pela primeira vez

```
1.  Browser abre index.html

2.  websocket.js conecta em ws://localhost:3000/ws
    → Indicador muda para "ao vivo" (verde)

3.  dashboard.js chama em paralelo:
    GET /api/dashboard/kpis        → Redis Cache (30s TTL) ou PostgreSQL
    GET /api/dashboard/chart       → PostgreSQL (últimos 7 dias)
    GET /api/dashboard/top-products → PostgreSQL (top 5 por vendas)
    GET /api/dashboard/alerts      → PostgreSQL (estoque ≤ 5)

4.  Browser renderiza os dados

5.  A partir daí, o WebSocket mantém tudo atualizado automaticamente
```

---

## 4. Redis — papel central no sistema

Redis é o componente mais crítico após o PostgreSQL. Ele serve **três funções distintas e simultâneas** neste sistema.

### 4.1 Fila de Jobs (BullMQ)

O BullMQ usa o Redis como banco de dados da fila. Cada webhook recebido vira um job persistido no Redis antes de ser processado.

```
Redis Key: bull:ml-webhooks:waiting
           bull:ml-webhooks:active
           bull:ml-webhooks:completed
           bull:ml-webhooks:failed
```

**Por que fila?**
- O ML exige resposta em < 500ms. O processamento real (chamar ML API, gravar no banco) demora mais.
- Com a fila, o gateway responde 200 imediatamente e o worker processa quando puder.
- Se o worker cair, os jobs ficam na fila e são reprocessados quando voltar.
- Backoff exponencial automático em caso de falha (2s → 4s → 8s).
- Até 3 tentativas automáticas por job.

**Configuração atual:**
```js
// server/src/queues/webhookQueue.js
new Queue('ml-webhooks', { connection: ioredis })

// server/src/routes/webhookGateway.js
await webhookQueue.add(topic, data, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 500,   // mantém os últimos 500 jobs concluídos
  removeOnFail: 1000,      // mantém os últimos 1000 jobs falhos
})
```

### 4.2 Cache de respostas da API

As rotas da REST API armazenam resultados no Redis para evitar queries repetidas ao PostgreSQL.

```
Redis Key: kpis:summary         TTL: 30 segundos
```

**Como funciona o helper de cache:**
```js
// server/src/routes/api.js
async function cached(key, ttlSeconds, fn) {
  const hit = await redis.get(key);          // tenta Redis primeiro
  if (hit) return JSON.parse(hit);           // cache hit → retorna em < 1ms
  const value = await fn();                  // cache miss → vai ao PostgreSQL
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}
```

**Invalidação de cache:**
Quando o worker processa um job e atualiza o banco, invalida imediatamente as chaves de cache afetadas:
```js
// server/src/worker.js
async function invalidateKPIs(storeId) {
  await redis.del('kpis:summary');       // invalida KPIs globais
  if (storeId) await redis.del(`kpis:${storeId}`); // invalida KPIs da loja
}
```

Isso garante que a próxima leitura do dashboard sempre reflete o estado atual do banco.

### 4.3 Pub/Sub para WebSocket multi-processo

O servidor HTTP e o Worker são **processos separados** (você os inicia em terminais diferentes). Para que o Worker possa notificar os browsers conectados ao servidor, eles se comunicam via Redis Pub/Sub.

```
                Worker (processo 2)
                       │
                       │ redis.publish('ml:ws:broadcast', mensagem)
                       ▼
              ┌─────────────────┐
              │   Redis Pub/Sub │
              │  Canal: ml:ws:  │
              │     broadcast   │
              └────────┬────────┘
                       │ subscriber.on('message', ...)
                       ▼
              Server (processo 1)
              ws/hub.js recebe
                       │
                       │ socket.send(mensagem)
                       ▼
              Todos os browsers conectados
```

**Implementação:**
```js
// server/src/ws/hub.js
const CHANNEL = 'ml:ws:broadcast';
const subscriber = redis.duplicate();   // conexão separada para subscribe

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', socket => clients.add(socket));

  subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_ch, message) => {
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  });
}

// Chamado pelo worker após processar um job
async function publish(topic, payload) {
  await redis.publish(CHANNEL, JSON.stringify({ topic, payload }));
}
```

**Por que precisamos do Pub/Sub?**
Se o worker tentasse enviar direto para os WebSockets, precisaria ter acesso ao objeto `wss` do servidor HTTP — o que forçaria os dois a rodar no mesmo processo. Com Redis Pub/Sub, podem rodar em máquinas diferentes e o sistema ainda funciona.

### 4.4 Resumo das chaves Redis usadas

| Chave | Tipo | TTL | Uso |
|---|---|---|---|
| `bull:ml-webhooks:*` | Hash/List | Sem TTL | Fila BullMQ (gerenciada automaticamente) |
| `kpis:summary` | String (JSON) | 30s | Cache dos KPIs do dashboard |
| `kpis:{storeId}` | String (JSON) | 30s | Cache dos KPIs por loja (futuro multi-loja) |
| `ml:ws:broadcast` | Pub/Sub Channel | N/A | Comunicação Worker → WebSocket Hub |

### 4.5 Requisitos do Redis

| Item | Valor |
|---|---|
| Versão mínima | 6.0 |
| Persistência | RDB recomendado (para sobreviver a reinicializações) |
| Memória típica | < 50 MB em operação normal |
| Conexões simultâneas | 3 por processo (publisher + subscriber + BullMQ) |

---

## 5. PostgreSQL — fonte única da verdade

Todo dado que entra no sistema passa pelo PostgreSQL. Nenhuma tela exibe dado que não tenha sido persistido antes.

**Por que PostgreSQL e não apenas Redis?**
- Redis é volátil por padrão — sem persistência configurada, dados somem se o serviço reiniciar
- PostgreSQL tem ACID — transações, constraints, integridade referencial
- Queries complexas (Curva ABC, análise por hora, comparativos) são calculadas com SQL no banco
- Histórico completo de pedidos, perguntas e webhooks fica disponível para análises

**Conexão — Pool de conexões:**
```js
// server/src/db/pool.js
const pool = new Pool({ connectionString: env.databaseUrl });
// pg usa pool por padrão: até 10 conexões simultâneas
```

**Padrão UPSERT (INSERT ... ON CONFLICT DO UPDATE):**
Todos os dados do ML são inseridos com UPSERT. Isso garante idempotência — se o mesmo webhook chegar duas vezes, o banco não duplica o registro.

```sql
-- Exemplo: orders
INSERT INTO orders (ml_id, status, total_amount, ...)
VALUES ($1, $2, $3, ...)
ON CONFLICT (ml_id) DO UPDATE SET
  status = EXCLUDED.status,
  total_amount = EXCLUDED.total_amount,
  updated_at = now()
```

---

## 6. WebSocket — atualização em tempo real

O cliente WebSocket (`js/websocket.js`) conecta automaticamente ao iniciar qualquer página e mantém a conexão viva com reconexão automática.

```js
// js/websocket.js — reconexão com backoff exponencial
this.socket.onclose = () => {
  setTimeout(() => this.connect(), this.reconnectDelay);
  this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  // começa em 2s, dobra a cada falha, máximo 30s
};
```

**Eventos disponíveis:**

| Evento | Emitido quando | Páginas que ouvem |
|---|---|---|
| `kpis_updated` | Pedido, pergunta ou item processado | Dashboard, Métricas, Lojas, Publicidade, Performance |
| `order_updated` | Novo pedido ou mudança de status | Dashboard, Pedidos, Vendas, Clientes, Devoluções |
| `question_received` | Nova pergunta | Perguntas, Dashboard |
| `message_received` | Nova mensagem no pack | Mensagens |
| `stock_alert` | Estoque ≤ 3 unidades | Dashboard, Reposição |
| `anuncio_updated` | Item alterado | Anúncios, Dashboard |
| `webhook_received` | Webhook enfileirado | Webhook (página de monitoramento) |

**Como usar nas páginas:**
```js
// Ouvir um evento específico
WS.on('order_updated', (payload) => {
  console.log('Pedido atualizado:', payload.id, payload.status);
  load(); // recarregar a tabela de pedidos
});

// Ouvir todos os eventos (para debugging)
WS.on('*', ({ topic, payload }) => {
  console.log('[WS]', topic, payload);
});

// Saber quando conectou
WS.on('_connected', () => {
  document.getElementById('wsStatus').textContent = 'ao vivo';
});
```

**Formato da mensagem WebSocket:**
```json
{
  "topic": "order_updated",
  "payload": {
    "id": 123456789,
    "status": "delivered",
    "total_amount": 149.90
  }
}
```

---

## 7. BullMQ — fila de jobs

O BullMQ gerencia o processamento assíncrono dos webhooks com retry automático, concorrência configurável e visibilidade do estado dos jobs.

**Topologia:**

```
webhookGateway.js        Redis (BullMQ)         worker.js
       │                      │                     │
  Recebe webhook              │                     │
       │                      │                     │
  Ack 200 ──────────────────► │                     │
                         Enfileira job              │
                              │ ◄─────────────────── │
                              │     Consome job      │
                              │                      │
                              │           Processa, grava PG,
                              │           invalida cache,
                              │           publica WS
```

**Topics suportados pelo worker:**

| Topic do webhook ML | Handler | O que faz |
|---|---|---|
| `orders_v2` | `handleOrder` | Busca pedido, grava `orders`, emite `order_updated` + `kpis_updated` |
| `payments` | `handleOrder` | Mesmo handler — pagamento atualiza o pedido |
| `questions` | `handleQuestion` | Busca pergunta, grava `questions`, emite `question_received` |
| `messages` | `handleMessage` | Busca pack, grava `messages`, emite `message_received` |
| `items` | `handleItem` | Busca item, grava `items`, emite `anuncio_updated` (+ `stock_alert` se ≤ 3) |

**Configuração de retry:**
```js
attempts: 3,
backoff: { type: 'exponential', delay: 2000 }
// Tentativa 1: imediata
// Tentativa 2: após 2 segundos
// Tentativa 3: após 4 segundos
```

---

## 8. Docker — ambiente de desenvolvimento

Docker é a forma mais rápida de ter PostgreSQL e Redis funcionando localmente, sem precisar instalar e configurar manualmente.

### 8.1 Opção A: apenas as dependências (recomendado para desenvolvimento)

Rode PostgreSQL e Redis no Docker, mas o Node.js rodando diretamente na sua máquina. Isso facilita o debug e o hot-reload.

Crie o arquivo `docker-compose.yml` na raiz do projeto:

```yaml
# docker-compose.yml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    container_name: ml_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ml_user
      POSTGRES_PASSWORD: ml_pass
      POSTGRES_DB: ml_dashboard
    ports:
      - "5432:5432"
    volumes:
      - ml_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ml_user -d ml_dashboard"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: ml_redis
    restart: unless-stopped
    command: >
      redis-server
      --save 60 1
      --loglevel warning
    ports:
      - "6379:6379"
    volumes:
      - ml_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  ml_pg_data:
  ml_redis_data:
```

**Comandos:**

```bash
# Iniciar PostgreSQL e Redis em background
docker compose up -d

# Verificar se os containers estão healthy
docker compose ps

# Ver logs do PostgreSQL
docker compose logs postgres

# Ver logs do Redis
docker compose logs redis

# Parar tudo (preserva dados nos volumes)
docker compose stop

# Parar e remover tudo (APAGA os dados)
docker compose down -v
```

Depois de subir os containers, o `.env` já funciona com os valores padrão:
```env
DATABASE_URL=postgres://ml_user:ml_pass@localhost:5432/ml_dashboard
REDIS_URL=redis://localhost:6379
```

### 8.2 Opção B: sistema completo no Docker (produção / staging)

Para rodar server + worker + dependências tudo junto:

Crie o arquivo `Dockerfile` dentro de `server/`:

```dockerfile
# server/Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/server.js"]
```

E o `docker-compose.prod.yml` na raiz:

```yaml
# docker-compose.prod.yml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - ml_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --save 60 1 --requirepass ${REDIS_PASSWORD}
    volumes:
      - ml_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  migrate:
    build:
      context: ./server
    command: node src/db/migrate.js
    env_file: ./server/.env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  server:
    build:
      context: ./server
    command: node src/server.js
    ports:
      - "3000:3000"
    env_file: ./server/.env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

  worker:
    build:
      context: ./server
    command: node src/worker.js
    env_file: ./server/.env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  ml_pg_data:
  ml_redis_data:
```

**Iniciar em produção/staging:**
```bash
# Certifique-se que server/.env está preenchido
docker compose -f docker-compose.prod.yml up -d

# Ver status de todos os serviços
docker compose -f docker-compose.prod.yml ps

# Ver logs em tempo real
docker compose -f docker-compose.prod.yml logs -f server worker

# Aplicar migração manualmente (se necessário)
docker compose -f docker-compose.prod.yml run --rm migrate
```

### 8.3 Inspecionar Redis via Docker

```bash
# Conectar no redis-cli dentro do container
docker exec -it ml_redis redis-cli

# Comandos úteis dentro do redis-cli:
PING                          # deve retornar PONG
KEYS *                        # lista todas as chaves
GET kpis:summary              # ver cache atual dos KPIs
LLEN bull:ml-webhooks:waiting # jobs na fila aguardando
LLEN bull:ml-webhooks:active  # jobs sendo processados agora
DEL kpis:summary              # forçar invalidação do cache
```

### 8.4 Inspecionar PostgreSQL via Docker

```bash
# Conectar no psql dentro do container
docker exec -it ml_postgres psql -U ml_user -d ml_dashboard

# Comandos úteis:
\dt                           # listar tabelas
SELECT COUNT(*) FROM orders;  # contar pedidos
SELECT * FROM webhook_logs ORDER BY received_at DESC LIMIT 10;
SELECT * FROM schedule_jobs;
```

### 8.5 Requisitos para Docker

| Item | Mínimo |
|---|---|
| Docker Engine | 24.x |
| Docker Compose | v2.x (`docker compose`, não `docker-compose`) |
| Memória RAM | 512 MB livres (postgres + redis + node) |
| Disco | 2 GB para volumes de dados |

---

## 9. Instalação sem Docker

### Pré-requisitos

| Software | Versão mínima | Como instalar |
|---|---|---|
| Node.js | 18.x | https://nodejs.org |
| PostgreSQL | 14+ | `apt install postgresql` |
| Redis | 6+ | `apt install redis-server` |

### Instalação automatizada

```bash
git clone https://github.com/souzashoppingonline-lab/mercadolivre-souza.git
cd mercadolivre-souza
bash install.sh
```

O script `install.sh`:
1. Verifica Node.js (v18+), npm e psql instalados
2. Instala dependências npm (`cd server && npm install`)
3. Cria `server/.env` a partir do `.env.example` (só se não existir)
4. Aguarda você editar o `.env` com suas credenciais
5. Testa conexão com PostgreSQL
6. Cria o banco de dados se não existir
7. Aplica o schema completo (`node src/db/migrate.js`)
8. Verifica conexão com Redis
9. Registra jobs de schedule na tabela

### Instalação manual

```bash
# 1. Dependências npm
cd server && npm install

# 2. Ambiente
cp server/.env.example server/.env
# editar server/.env com suas credenciais

# 3. Criar banco e aplicar schema
createdb ml_dashboard
cd server && node src/db/migrate.js

# 4. Cadastrar sua loja (após obter tokens OAuth)
psql $DATABASE_URL -c "
INSERT INTO stores (id, nickname, access_token, refresh_token, token_expires_at)
VALUES (SEU_USER_ID, 'NomeDaLoja', 'APP_USR-...', 'TG-...', NOW() + INTERVAL '6 hours');
"
```

---

## 10. Variáveis de ambiente

Arquivo: `server/.env` (criado a partir de `server/.env.example`)

```env
# ── Servidor ──────────────────────────────────────────────────────
PORT=3000

# ── PostgreSQL ────────────────────────────────────────────────────
# Formato: postgres://usuario:senha@host:porta/banco
DATABASE_URL=postgres://ml_user:ml_pass@localhost:5432/ml_dashboard

# ── Redis ─────────────────────────────────────────────────────────
# Usado para: fila BullMQ + cache de API + pub/sub WebSocket
# Formato: redis://[:senha@]host:porta[/numero_do_banco]
REDIS_URL=redis://localhost:6379

# Se Redis tem senha (recomendado em produção):
# REDIS_URL=redis://:minhasenha@localhost:6379

# ── Mercado Livre ─────────────────────────────────────────────────
# Crie o app em: https://developers.mercadolivre.com.br/devcenter
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=https://seu-dominio.com/auth/callback

# ── Telegram (opcional) ───────────────────────────────────────────
# Para alertas de estoque crítico, falhas, etc.
# Criar bot: https://t.me/BotFather
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | Não | `3000` | Porta HTTP do servidor |
| `DATABASE_URL` | Sim | — | String de conexão PostgreSQL |
| `REDIS_URL` | Não | `redis://localhost:6379` | URL do Redis |
| `ML_CLIENT_ID` | Sim | — | Client ID do App ML |
| `ML_CLIENT_SECRET` | Sim | — | Client Secret do App ML |
| `ML_REDIRECT_URI` | Sim | — | URI de callback OAuth |
| `TELEGRAM_BOT_TOKEN` | Não | — | Token do bot Telegram |
| `TELEGRAM_CHAT_ID` | Não | — | Chat ID para alertas |

---

## 11. Inicialização

### Dois processos obrigatórios

```bash
# Terminal 1 — Servidor HTTP + WebSocket
cd server
npm start

# Saída esperada:
# [server] listening on :3000
# [server] REST API:    http://localhost:3000/api
# [server] Webhook URL: http://localhost:3000/webhooks/ml
# [server] WebSocket:   ws://localhost:3000/ws
```

```bash
# Terminal 2 — Worker BullMQ (processa webhooks)
cd server
npm run worker

# Saída esperada:
# [worker] listening for ml-webhooks jobs...
```

### Frontend

O frontend é HTML/CSS/JS puro — não requer build. Abra direto no browser:

```bash
# Opção 1: servidor estático simples
npx serve .        # na raiz do projeto
# acesse http://localhost:3000 (ou a porta indicada pelo serve)

# Opção 2: qualquer servidor HTTP
python3 -m http.server 8080

# Opção 3: abrir direto (pode ter limitações de CORS em alguns browsers)
open index.html    # macOS
xdg-open index.html # Linux
```

**Configurar URL do backend no browser (se diferente do padrão):**
```js
// Execute no console do browser para configurar:
localStorage.setItem('ml_backend_url', 'http://192.168.1.100:3000/api');
localStorage.setItem('ml_ws_url', 'ws://192.168.1.100:3000/ws');
location.reload();
```

---

## 12. Estrutura de arquivos

```
mercadolivre-souza/
│
├── index.html                    # Dashboard principal (página inicial)
│
├── pages/                        # 25 páginas do sistema
│   ├── anuncios.html             # Lista e busca de anúncios
│   ├── pedidos.html              # Pedidos com filtros
│   ├── vendas.html               # Evolução de vendas + gráfico
│   ├── perguntas.html            # Perguntas pendentes + responder
│   ├── mensagens.html            # Conversas com compradores
│   ├── metricas.html             # Reputação e métricas ML
│   ├── clientes.html             # Base de clientes
│   ├── lojas.html                # Contas ML cadastradas
│   ├── horarios.html             # Vendas por hora do dia
│   ├── diasemana.html            # Vendas por dia da semana
│   ├── produtos.html             # Catálogo de produtos
│   ├── performance.html          # Taxa de conversão e visitas
│   ├── publicidade.html          # Campanhas Produto Anúncio
│   ├── concorrentes.html         # Análise de concorrentes
│   ├── periodo.html              # Comparativo período vs período
│   ├── evolucao.html             # Evolução diária
│   ├── curvaABC.html             # Classificação ABC de produtos
│   ├── reposicao.html            # Alertas de estoque baixo
│   ├── cancelamentos.html        # Pedidos cancelados
│   ├── devolucoes.html           # Devoluções e reclamações
│   ├── anuncios-problema.html    # Anúncios pausados/sem estoque
│   ├── monitor.html              # Monitor em tempo real + Telegram
│   ├── schedule.html             # Jobs de sincronização
│   └── webhook.html              # Histórico de webhooks recebidos
│
├── js/
│   ├── db.js                     # Cliente REST → chama /api/* do backend
│   │                             # NUNCA chama a API do ML diretamente
│   ├── websocket.js              # Cliente WebSocket com reconexão automática
│   ├── dashboard.js              # Lógica da index.html
│   ├── layout.js                 # Gera sidebar + topbar dinamicamente
│   ├── sidebar.js                # Toggle da sidebar (abrir/fechar)
│   └── api.js                    # LEGADO: cliente direto da API ML
│                                 # Não usado nas páginas. Mantido para auth.
│
├── css/
│   ├── style.css                 # Estilos globais e tema escuro
│   ├── sidebar.css               # Sidebar e navegação
│   └── cards.css                 # Cards, tabelas, badges, componentes
│
├── server/
│   ├── .env.example              # Modelo de variáveis de ambiente
│   ├── package.json              # Dependências: express, pg, ioredis, bullmq, ws
│   │
│   └── src/
│       ├── server.js             # Entry point do Node.js
│       │                         # Liga: Express, middleware, rotas, WebSocket
│       │
│       ├── worker.js             # Processo separado do server
│       │                         # Consome BullMQ, chama ML API, grava PG,
│       │                         # invalida cache Redis, emite WebSocket
│       │
│       ├── mlClient.js           # Wrapper da API do ML
│       │                         # Busca token no banco por storeId
│       │                         # SOMENTE importado pelo worker.js
│       │
│       ├── config/
│       │   └── env.js            # Lê e valida process.env
│       │
│       ├── db/
│       │   ├── pool.js           # Pool pg (até 10 conexões PostgreSQL)
│       │   ├── redis.js          # Cliente ioredis compartilhado
│       │   ├── schema.sql        # DDL completo (tabelas + índices)
│       │   └── migrate.js        # Executa schema.sql no banco
│       │
│       ├── queues/
│       │   └── webhookQueue.js   # Define fila BullMQ 'ml-webhooks'
│       │                         # Importado tanto pelo gateway quanto pelo worker
│       │
│       ├── routes/
│       │   ├── api.js            # 30+ endpoints REST do frontend
│       │   │                     # Lê PG/Redis. Nunca chama ML.
│       │   └── webhookGateway.js # POST /webhooks/ml
│       │                         # Ack imediato → log PG → job BullMQ
│       └── ws/
│           └── hub.js            # WebSocket server
│                                 # Redis pub/sub broadcaster
│                                 # Exporta attach() e publish()
│
├── install.sh                    # Instalação automatizada
├── CLAUDE.md                     # Memória do projeto para sessões Claude
└── README.md                     # Esta documentação
```

---

## 13. Banco de dados — tabelas e schema

### Diagrama de relacionamentos

```
stores (1) ──────────────────────────────────────── (N) items
  │                                                        │
  ├── (N) orders ── (1) returns                            │
  │                                                        │
  ├── (N) questions                                        │
  │                                                        │
  ├── (N) messages                                         │
  │                                                        │
  └── (N) ads_campaigns ──────────────────────────── item_id → items.ml_id

  webhook_logs   (sem FK — log de tudo que chega)
  schedule_jobs  (sem FK — controle de sincronização)
```

### Tabelas

#### `stores` — Contas do Mercado Livre

```sql
id              BIGINT PRIMARY KEY    -- user_id do ML (ex: 123456789)
nickname        TEXT                  -- nome da loja no ML
level_id        TEXT                  -- nível de reputação (gold, platinum...)
access_token    TEXT                  -- token OAuth para chamar a API ML
refresh_token   TEXT                  -- para renovar o access_token
token_expires_at TIMESTAMPTZ          -- quando o access_token expira (6h)
active_listings INT                   -- cache do nº de anúncios ativos
monthly_revenue NUMERIC               -- cache da receita mensal
reputation_data JSONB                 -- dados brutos de reputação do ML
updated_at      TIMESTAMPTZ
```

#### `items` — Anúncios/Produtos

```sql
ml_id              TEXT PRIMARY KEY   -- ID do item no ML (ex: MLB123456789)
store_id           BIGINT FK stores   
title              TEXT               -- título do anúncio
price              NUMERIC            -- preço atual
available_quantity INT                -- estoque atual
sold_quantity      INT                -- total de vendas
status             TEXT               -- active | paused | closed
category_id        TEXT               -- categoria ML
visits             INT                -- visitas (via scheduler)
position           INT                -- posição na busca (via scheduler)
updated_at         TIMESTAMPTZ
```

#### `orders` — Pedidos

```sql
ml_id          BIGINT PRIMARY KEY     -- ID do pedido no ML
store_id       BIGINT FK stores
buyer_nickname TEXT                   -- nickname do comprador
buyer_id       BIGINT                 -- user_id do comprador
title          TEXT                   -- título do primeiro item
total_amount   NUMERIC                -- valor total do pedido
status         TEXT                   -- paid | shipped | delivered | cancelled...
cancelled_by   TEXT                   -- buyer | seller | system
cancel_reason  TEXT                   -- motivo do cancelamento
date_created   TIMESTAMPTZ
date_closed    TIMESTAMPTZ
updated_at     TIMESTAMPTZ
```

#### `questions` — Perguntas

```sql
ml_id         BIGINT PRIMARY KEY     -- ID da pergunta no ML
store_id      BIGINT FK stores
item_id       TEXT                   -- ID do item questionado
item_title    TEXT                   -- título do item (denormalizado para performance)
text          TEXT                   -- texto da pergunta
answer_text   TEXT                   -- texto da resposta (null se não respondida)
answered_at   TIMESTAMPTZ            -- quando foi respondida
status        TEXT                   -- UNANSWERED | ANSWERED | CLOSED_UNANSWERED
date_created  TIMESTAMPTZ
updated_at    TIMESTAMPTZ
```

#### `messages` — Mensagens

```sql
id                BIGSERIAL PRIMARY KEY
store_id          BIGINT FK stores
pack_id           TEXT               -- ID do pack (conversa)
buyer_nickname    TEXT
last_message      TEXT               -- último texto recebido
unread            INT                -- nº de mensagens não lidas
last_message_date TIMESTAMPTZ
updated_at        TIMESTAMPTZ
```

#### `returns` — Devoluções

```sql
id         BIGSERIAL PRIMARY KEY
store_id   BIGINT FK stores
order_id   BIGINT FK orders
title      TEXT                      -- produto devolvido
reason     TEXT                      -- motivo da devolução
amount     NUMERIC                   -- valor a devolver
status     TEXT                      -- analysis | approved | rejected
date       TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

#### `ads_campaigns` — Publicidade (Produto Anúncio)

```sql
id          BIGSERIAL PRIMARY KEY
store_id    BIGINT FK stores
item_id     TEXT                     -- item anunciado
title       TEXT                     -- título do anúncio
impressions BIGINT                   -- nº de impressões
clicks      INT                      -- nº de cliques
spend       NUMERIC                  -- gasto em R$
revenue     NUMERIC                  -- receita gerada pelos anúncios
date        DATE                     -- data de referência
updated_at  TIMESTAMPTZ
```

#### `webhook_logs` — Histórico de webhooks

```sql
id           BIGSERIAL PRIMARY KEY
topic        TEXT NOT NULL           -- orders_v2 | questions | messages | items
resource     TEXT NOT NULL           -- /orders/123456 | /questions/789...
store_id     BIGINT                  -- loja que recebeu o evento
status       TEXT                    -- pending | processed | failed
error        TEXT                    -- mensagem de erro (se status=failed)
received_at  TIMESTAMPTZ             -- quando chegou
processed_at TIMESTAMPTZ             -- quando foi processado
```

#### `schedule_jobs` — Controle de sincronização

```sql
name        TEXT PRIMARY KEY         -- refresh_token | sync_inventory | ...
cron        TEXT                     -- expressão cron (ex: "0 */2 * * *")
last_run    TIMESTAMPTZ              -- última execução
duration_ms INT                      -- duração em ms
status      TEXT                     -- idle | running | success | error | queued
```

### Índices

```sql
-- Orders
idx_orders_store_status  ON orders(store_id, status)   -- filtrar por loja+status
idx_orders_date          ON orders(date_created)       -- filtrar por período
idx_orders_buyer         ON orders(buyer_nickname)     -- buscar clientes

-- Items
idx_items_store_status   ON items(store_id, status)    -- filtrar por loja+status
idx_items_sold           ON items(sold_quantity DESC)  -- ordenar por vendas

-- Questions
idx_questions_status     ON questions(status)          -- filtrar sem resposta

-- Webhook logs
idx_webhook_logs_topic   ON webhook_logs(topic)        -- filtrar por tipo
idx_webhook_logs_status  ON webhook_logs(status)       -- filtrar por estado
idx_webhook_logs_date    ON webhook_logs(received_at)  -- filtrar por data

-- Ads
idx_ads_date             ON ads_campaigns(date)        -- filtrar campanhas do dia
```

---

## 14. API REST — referência completa

Base URL: `http://localhost:3000/api`

Todas as respostas são JSON. Erros retornam `{ "error": "mensagem" }`.

### Dashboard

| Método | Rota | Cache | Descrição |
|---|---|---|---|
| GET | `/dashboard/kpis` | 30s Redis | Vendas hoje, pedidos, perguntas, alertas |
| GET | `/dashboard/chart?period=7` | Não | Gráfico de receita (7/30/90 dias) |
| GET | `/dashboard/top-products?limit=10` | Não | Top N produtos por vendas |
| GET | `/dashboard/alerts` | Não | Produtos com estoque ≤ 5 |

### Anúncios e Produtos

| Método | Rota | Descrição |
|---|---|---|
| GET | `/anuncios?status=&search=&page=1&limit=20` | Lista com filtro e paginação |
| GET | `/produtos` | Lista por vendas (sem paginação) |
| GET | `/produtos/performance` | Itens com visitas e conversão |

### Pedidos e Vendas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/pedidos?status=&dateFrom=&dateTo=` | Lista com summary (total hoje, em trânsito...) |
| GET | `/vendas` | Summary geral (hoje, mês, ticket médio) |
| GET | `/vendas/diarias?days=30` | Linha do tempo + summary |

### Perguntas e Mensagens

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/perguntas?status=UNANSWERED` | — | Lista com summary (tempo médio de resposta) |
| POST | `/perguntas/:id/responder` | `{ "text": "..." }` | Grava resposta no banco |
| GET | `/mensagens` | — | Conversas recentes por pack |

### Clientes, Lojas e Métricas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/clientes?search=` | Buyers agrupados com total gasto |
| GET | `/lojas` | Todas as contas ML cadastradas |
| GET | `/metricas` | Reputação da primeira loja (a multi-loja é futura) |

### Análises

| Método | Rota | Descrição |
|---|---|---|
| GET | `/analises/horarios` | Pedidos + receita por hora (últimos 30d) |
| GET | `/analises/dias-semana` | Pedidos + receita por dia da semana (últimos 90d) |
| GET | `/publicidade` | Campanhas do dia + summary (ACOS, gasto, receita) |
| GET | `/concorrentes?itemId=` | Placeholder — populado por scheduler futuro |

### Comparativos

| Método | Rota | Descrição |
|---|---|---|
| GET | `/comparativos/periodos?p1=30&p2=60` | Período 1 (últimos p1 dias) vs Período 2 (p2→p1 dias atrás) |
| GET | `/comparativos/evolucao?days=30` | Receita diária sem summary |
| GET | `/comparativos/curva-abc` | Classifica items: A (80%), B (95%), C (resto) |

### Alertas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/alertas/reposicao` | Items ativos com estoque ≤ 15 + velocidade de venda |
| GET | `/alertas/cancelamentos?limit=100` | Pedidos cancelados + summary |
| GET | `/alertas/devolucoes` | Tabela `returns` + summary |
| GET | `/alertas/anuncios-problema` | Items pausados/fechados/sem estoque |

### Sistema

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/webhooks/logs?topic=&limit=50` | — | Histórico de webhooks |
| GET | `/webhooks/config` | — | Status do dia (recebidos, processados, falhos) |
| POST | `/webhooks/config` | qualquer | Placeholder para salvar config |
| GET | `/schedule/jobs` | — | Status de todos os jobs |
| POST | `/schedule/jobs/:name/trigger` | — | Enfileira job para execução |
| GET | `/health` | — | `{"ok":true}` |

---

## 15. Scheduler — sincronização inteligente

O Webhook do ML **não entrega** todos os dados necessários. Ele avisa que algo mudou, mas não diz, por exemplo, quantas visitas um produto recebeu ou qual é o gasto de Produto Anúncio hoje.

Para isso existe o scheduler: chamadas controladas à API do ML em horários de baixo impacto.

**Status atual:** os jobs estão registrados na tabela `schedule_jobs` e podem ser disparados manualmente via `POST /api/schedule/jobs/:name/trigger`. O processo autônomo ainda será implementado.

**Cadência planejada:**

| Job | Cron | Intervalo | O que faz |
|---|---|---|---|
| `refresh_token` | `0 */5 * * *` | A cada 5 horas | Renova o OAuth access_token de cada loja |
| `sync_inventory` | `0 */2 * * *` | A cada 2 horas | Atualiza estoque em lotes de 5 itens, 5 min entre lotes |
| `sync_visits` | `0 2 * * *` | 02:00 diário | Visitas dos últimos 7 dias por item |
| `sync_performance` | `0 3 * * *` | 03:00 diário | Métricas de performance e posição |
| `sync_items` | `0 4 * * *` | 04:00 diário | Sincroniza catálogo completo de anúncios |

**Princípio do scheduler:**
- Nunca sincronizar o que o webhook já entrega
- Lotes pequenos com pausa entre eles (respeitar rate limit)
- Backoff exponencial em caso de 429 (Too Many Requests)
- Registrar duração e status em `schedule_jobs` para monitoramento

---

## 16. Configurar Webhook no Mercado Livre

### Passo a passo

1. Acesse: **https://developers.mercadolivre.com.br/devcenter**
2. Clique na sua aplicação
3. Na seção **Notificações**, configure:
   - **URL de callback:** `https://seu-dominio.com/webhooks/ml`
   - **Tópicos ativos:** marque todos abaixo

**Tópicos recomendados:**

| Tópico | Eventos |
|---|---|
| `orders_v2` | Novos pedidos, mudanças de status |
| `payments` | Pagamentos confirmados ou contestados |
| `questions` | Novas perguntas de compradores |
| `messages` | Novas mensagens no pós-venda |
| `items` | Alterações em anúncios (preço, estoque, status) |

### Para testes locais com ngrok

```bash
# Instale ngrok: https://ngrok.com/download
ngrok http 3000

# A URL gerada terá formato:
# https://abcd1234.ngrok.io

# Configure no ML:
# https://abcd1234.ngrok.io/webhooks/ml
```

### Testar webhook manualmente

```bash
# Simular chegada de um pedido
curl -X POST http://localhost:3000/webhooks/ml \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "orders_v2",
    "resource": "/orders/123456789",
    "user_id": 987654321,
    "application_id": 0,
    "sent": "2024-01-15T10:30:00.000Z",
    "attempts": 1
  }'

# Deve retornar HTTP 200 imediatamente

# Verificar se foi enfileirado
curl http://localhost:3000/api/webhooks/logs
```

---

## 17. Checklist de testes

### Infraestrutura

- [ ] PostgreSQL rodando e acessível
- [ ] Redis rodando (`redis-cli ping` retorna `PONG`)
- [ ] `npm start` sem erros (Terminal 1)
- [ ] `npm run worker` sem erros (Terminal 2)
- [ ] `GET http://localhost:3000/health` retorna `{"ok":true}`

### Banco de dados

- [ ] `node src/db/migrate.js` executa sem erros
- [ ] Todas as tabelas existem (`\dt` no psql)
- [ ] Uma loja está cadastrada em `stores`

### Webhook

- [ ] `POST /webhooks/ml` retorna 200 em < 100ms
- [ ] Log aparece em `GET /api/webhooks/logs` com `status: pending`
- [ ] Worker processa e atualiza para `status: processed`
- [ ] Evento WebSocket chega no browser (abrir console do browser)

### API REST

- [ ] `GET /api/dashboard/kpis` retorna JSON válido
- [ ] `GET /api/pedidos` retorna estrutura `{ results, summary }`
- [ ] `GET /api/comparativos/curva-abc` calcula e classifica produtos
- [ ] `POST /api/perguntas/1/responder` retorna `{"ok":true}`

### Frontend

- [ ] `index.html` abre sem erros no console
- [ ] Indicador WebSocket muda para "ao vivo" (verde)
- [ ] KPIs exibem valores do banco (não zeros ou traços)
- [ ] Ao enviar webhook, KPIs atualizam sem reload

### Páginas individuais

- [ ] Pedidos — filtro por status e por data funcionam
- [ ] Anúncios — busca por título funciona
- [ ] Perguntas — botão "Responder" grava no banco
- [ ] Curva ABC — gráfico de Pareto é gerado com dados reais
- [ ] Horários — gráfico de barras por hora do dia
- [ ] Cancelamentos — lista com pedidos cancelados

---

## 18. Problemas comuns

### Redis não conecta

```bash
# Verificar se está rodando
redis-cli ping
# → PONG = OK

# Iniciar se parado
sudo systemctl start redis        # Linux com systemd
redis-server --daemonize yes      # manual

# Com Docker
docker compose up -d redis
docker exec -it ml_redis redis-cli ping
```

### PostgreSQL recusa conexão

```bash
# Verificar se está rodando
pg_isready -h localhost -p 5432

# Testar a DATABASE_URL diretamente
psql $DATABASE_URL -c "SELECT 1"

# Ver logs do PostgreSQL
sudo journalctl -u postgresql -n 50

# Com Docker
docker compose logs postgres
docker exec -it ml_postgres psql -U ml_user -d ml_dashboard -c "SELECT 1"
```

### Worker não processa jobs

```bash
# Causa mais comum: Redis não está rodando
redis-cli ping

# Verificar se há jobs na fila
redis-cli LLEN bull:ml-webhooks:waiting

# Ver jobs com falha
redis-cli LLEN bull:ml-webhooks:failed

# Verificar logs do worker
# Os erros aparecem direto no terminal onde rodou npm run worker
```

### WebSocket não conecta (indicador vermelho/laranja)

1. Verifique se `npm start` está rodando
2. Abra o console do browser → Network → WS — veja se há a conexão
3. Confirme a URL: `localStorage.getItem('ml_ws_url')` (padrão: `ws://localhost:3000/ws`)
4. Se estiver em host diferente: `localStorage.setItem('ml_ws_url', 'ws://SEU_IP:3000/ws')`

### Dashboard exibe traços (`—`) em todos os campos

- Confirme que o backend está rodando (`GET /health`)
- Abra o console do browser e veja se há erros de `fetch`
- Verifique CORS: o browser bloqueia requests de `file://` para `localhost`
  → Use um servidor HTTP: `npx serve .`
- Confirme a URL: `localStorage.getItem('ml_backend_url')` (padrão: `http://localhost:3000/api`)

### Cache Redis não está sendo invalidado

```bash
# Ver o conteúdo atual do cache
redis-cli GET kpis:summary

# Forçar invalidação manual
redis-cli DEL kpis:summary

# A próxima leitura vai ao PostgreSQL e repovoar o cache
```

### Erro ao aplicar migração

```bash
# Ver o erro completo
cd server && node src/db/migrate.js

# Causa comum: banco não existe
createdb ml_dashboard

# Ou permissões insuficientes — verificar no psql:
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ml_dashboard TO ml_user;"
```

---

## Licença

Proprietário — souzashopping.online
