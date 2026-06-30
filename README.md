# ML Dashboard

Dashboard de gestão para Mercado Livre com arquitetura orientada a eventos — sem polling, sem rate limit.

---

## Arquitetura

```
Mercado Livre
     │
     │  Webhook (pedidos, perguntas, mensagens, itens)
     ▼
┌────────────────────────────────────┐
│           Node.js Server           │
│                                    │
│  Express (/webhooks/ml)  → BullMQ  │
│  REST API (/api/*)                 │
│  WebSocket (/ws)                   │
│  PostgreSQL  ←→  Redis Cache       │
└────────────────────────────────────┘
     │
     │  WebSocket push (kpis_updated, order_updated …)
     ▼
┌──────────┐  ┌────────────┐  ┌──────────┐
│Dashboard │  │ Financeiro │  │ Estoque  │  … (25 páginas)
└──────────┘  └────────────┘  └──────────┘
```

**Princípios:**
- Webhooks primeiro — toda mudança entra via push do ML
- Dashboards leem exclusivamente PostgreSQL + Redis Cache
- API do ML é chamada apenas pelo Worker, somente para o recurso que mudou
- Mais de 95% das chamadas à API são eliminadas

---

## Fluxo de dados

```
1. Webhook chega em POST /webhooks/ml
2. Server faz ack 200 imediato (ML não espera processamento)
3. Job é enfileirado no BullMQ (Redis)
4. Worker consome o job:
   a. Busca o recurso alterado na API do ML (1 chamada cirúrgica)
   b. Grava/atualiza no PostgreSQL
   c. Invalida chaves de cache no Redis
   d. Publica evento WebSocket via Redis pub/sub
5. Todas as telas conectadas recebem a atualização em tempo real
```

---

## Pré-requisitos

| Dependência | Versão mínima |
|---|---|
| Node.js | 18.x |
| PostgreSQL | 14+ |
| Redis | 6+ |

---

## Instalação rápida

```bash
# Clone o repositório
git clone https://github.com/souzashoppingonline-lab/mercadolivre-souza.git
cd mercadolivre-souza

# Execute o instalador
bash install.sh
```

O instalador realiza automaticamente:
1. Verifica Node.js, npm e PostgreSQL
2. Instala dependências npm
3. Cria o arquivo `server/.env` a partir do `.env.example`
4. Cria o banco de dados e aplica o schema
5. Verifica a conexão Redis
6. Registra os jobs de schedule

---

## Instalação manual (passo a passo)

### 1. Dependências

```bash
cd server
npm install
```

### 2. Variáveis de ambiente

```bash
cp server/.env.example server/.env
```

Edite `server/.env`:

```env
PORT=3000

# PostgreSQL
DATABASE_URL=postgres://ml_user:ml_pass@localhost:5432/ml_dashboard

# Redis (BullMQ + Cache + WebSocket pub/sub)
REDIS_URL=redis://localhost:6379

# Credenciais do App no Mercado Livre
# Obtenha em: https://developers.mercadolivre.com.br/devcenter
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=http://seu-dominio.com/auth/callback

# Notificações Telegram (opcional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 3. Banco de dados

```bash
# Criar banco
createdb ml_dashboard

# Aplicar schema
cd server && node src/db/migrate.js
```

### 4. Cadastrar sua loja

Execute no PostgreSQL após obter o token de acesso via OAuth:

```sql
INSERT INTO stores (id, nickname, access_token, refresh_token, token_expires_at)
VALUES (
  123456789,            -- seu user_id do Mercado Livre
  'MinhaLoja',
  'APP_USR-...',        -- access_token obtido via OAuth
  'TG-...',             -- refresh_token
  NOW() + INTERVAL '6 hours'
);
```

---

## Inicialização

Abra **dois terminais**:

```bash
# Terminal 1 — Servidor HTTP + WebSocket
cd server
npm start
```

```bash
# Terminal 2 — Worker BullMQ (processa webhooks em background)
cd server
npm run worker
```

Abra o dashboard no browser:
```
# Abra index.html diretamente no browser, ou sirva com qualquer servidor estático:
npx serve .           # na raiz do projeto
# Acesse: http://localhost:3000
```

---

## Configuração do Webhook no Mercado Livre

1. Acesse: https://developers.mercadolivre.com.br/devcenter
2. Selecione seu App
3. Em **Notificações**, adicione o endpoint:
   ```
   https://seu-dominio.com/webhooks/ml
   ```
4. Tópicos recomendados: `orders_v2`, `payments`, `questions`, `messages`, `items`

Para **testes locais** com ngrok:

```bash
ngrok http 3000
# Use a URL gerada: https://xxxx.ngrok.io/webhooks/ml
```

---

## Estrutura do projeto

```
mercadolivre-souza/
├── index.html              # Dashboard principal
├── pages/                  # 25 páginas do sistema
│   ├── pedidos.html
│   ├── vendas.html
│   ├── anuncios.html
│   ├── perguntas.html
│   ├── mensagens.html
│   ├── clientes.html
│   ├── metricas.html
│   ├── lojas.html
│   ├── horarios.html
│   ├── diasemana.html
│   ├── produtos.html
│   ├── performance.html
│   ├── publicidade.html
│   ├── concorrentes.html
│   ├── periodo.html
│   ├── evolucao.html
│   ├── curvaABC.html
│   ├── reposicao.html
│   ├── cancelamentos.html
│   ├── devolucoes.html
│   ├── anuncios-problema.html
│   ├── monitor.html
│   ├── schedule.html
│   ├── webhook.html
│   └── lojas.html
├── js/
│   ├── db.js               # Cliente REST para o backend (/api/*)
│   ├── websocket.js        # Cliente WebSocket com reconexão automática
│   ├── dashboard.js        # Lógica do dashboard principal
│   ├── layout.js           # Sidebar e topbar injetados dinamicamente
│   └── sidebar.js          # Toggle da sidebar
├── css/
│   ├── style.css
│   ├── sidebar.css
│   └── cards.css
├── server/
│   ├── .env.example        # Modelo de variáveis de ambiente
│   ├── package.json
│   └── src/
│       ├── server.js       # Entry point (Express + WebSocket)
│       ├── worker.js       # BullMQ Worker (processa jobs de webhook)
│       ├── mlClient.js     # Chamadas à API do ML (SOMENTE pelo worker)
│       ├── config/env.js
│       ├── db/
│       │   ├── pool.js     # Pool de conexões PostgreSQL
│       │   ├── redis.js    # Cliente Redis
│       │   ├── schema.sql  # Schema completo do banco
│       │   └── migrate.js  # Runner de migração
│       ├── queues/
│       │   └── webhookQueue.js  # Fila BullMQ
│       ├── routes/
│       │   ├── api.js           # REST API (lê PG/Redis, nunca a API do ML)
│       │   └── webhookGateway.js # Recebe webhooks, enfileira jobs
│       └── ws/
│           └── hub.js           # WebSocket hub (Redis pub/sub)
├── install.sh              # Script de instalação automatizada
└── README.md               # Esta documentação
```

---

## API REST — Referência

Todas as rotas estão em `http://localhost:3000/api/`.

### Dashboard
| Método | Rota | Descrição |
|---|---|---|
| GET | `/dashboard/kpis` | KPIs principais (cache 30s) |
| GET | `/dashboard/chart?period=7` | Gráfico de vendas (7/30/90 dias) |
| GET | `/dashboard/top-products?limit=10` | Top produtos por vendas |
| GET | `/dashboard/alerts` | Alertas de estoque baixo |

### Anúncios e Produtos
| Método | Rota | Descrição |
|---|---|---|
| GET | `/anuncios?status=active&search=&page=1` | Lista de anúncios |
| GET | `/produtos` | Lista de produtos ordenada por vendas |
| GET | `/produtos/performance` | Performance com taxa de conversão |

### Pedidos e Vendas
| Método | Rota | Descrição |
|---|---|---|
| GET | `/pedidos?status=&dateFrom=&dateTo=` | Lista de pedidos com summary |
| GET | `/vendas` | Summary geral de vendas |
| GET | `/vendas/diarias?days=30` | Evolução diária com summary |

### Perguntas e Mensagens
| Método | Rota | Descrição |
|---|---|---|
| GET | `/perguntas?status=UNANSWERED` | Perguntas com summary |
| POST | `/perguntas/:id/responder` | Marcar resposta no banco |
| GET | `/mensagens` | Conversas recentes |

### Clientes, Lojas e Métricas
| Método | Rota | Descrição |
|---|---|---|
| GET | `/clientes?search=` | Lista de clientes com summary |
| GET | `/lojas` | Lista de contas ML cadastradas |
| GET | `/metricas` | Dados de reputação do vendedor |

### Análises
| Método | Rota | Descrição |
|---|---|---|
| GET | `/analises/horarios` | Pedidos agrupados por hora |
| GET | `/analises/dias-semana` | Pedidos agrupados por dia da semana |
| GET | `/publicidade` | Campanhas Produto Anúncio |
| GET | `/concorrentes?itemId=` | Concorrentes por produto |

### Comparativos
| Método | Rota | Descrição |
|---|---|---|
| GET | `/comparativos/periodos?p1=30&p2=60` | Comparativo entre períodos |
| GET | `/comparativos/evolucao?days=30` | Evolução diária |
| GET | `/comparativos/curva-abc` | Classificação ABC calculada pelo banco |

### Alertas
| Método | Rota | Descrição |
|---|---|---|
| GET | `/alertas/reposicao` | Produtos com estoque ≤ 15 |
| GET | `/alertas/cancelamentos` | Pedidos cancelados |
| GET | `/alertas/devolucoes` | Solicitações de devolução |
| GET | `/alertas/anuncios-problema` | Anúncios pausados/sem estoque |

### Sistema
| Método | Rota | Descrição |
|---|---|---|
| GET | `/webhooks/logs?topic=&limit=50` | Histórico de webhooks recebidos |
| GET | `/webhooks/config` | Status do processamento de hoje |
| GET | `/schedule/jobs` | Jobs de sincronização |
| POST | `/schedule/jobs/:name/trigger` | Dispara um job manualmente |
| GET | `/health` | Health check do servidor |

---

## WebSocket — Eventos

O frontend se conecta em `ws://localhost:3000/ws`. Cada mensagem tem o formato:

```json
{ "topic": "order_updated", "payload": { "id": 123, "status": "delivered" } }
```

| Evento | Quando é emitido |
|---|---|
| `kpis_updated` | Após processar pedido, pergunta ou item |
| `order_updated` | Novo pedido ou mudança de status |
| `question_received` | Nova pergunta recebida |
| `message_received` | Nova mensagem no pack |
| `stock_alert` | Estoque de item atingiu ≤ 3 unidades |
| `anuncio_updated` | Item alterado (preço, status, estoque) |
| `webhook_received` | Webhook recebido e enfileirado |

---

## Banco de dados — Tabelas

| Tabela | Conteúdo |
|---|---|
| `stores` | Contas do Mercado Livre com tokens OAuth |
| `orders` | Pedidos com status, valor, comprador |
| `items` | Anúncios com preço, estoque, vendas |
| `questions` | Perguntas e respostas |
| `messages` | Últimas mensagens por conversa (pack) |
| `returns` | Solicitações de devolução |
| `ads_campaigns` | Métricas de Produto Anúncio (via scheduler) |
| `webhook_logs` | Histórico de todos os webhooks recebidos |
| `schedule_jobs` | Status e histórico dos jobs de sincronização |

---

## Scheduler

O scheduler complementa os dados que o Webhook não entrega (visitas, publicidade, performance). Ainda não implementado como processo autônomo — os jobs são registrados na tabela `schedule_jobs` e podem ser disparados manualmente via API.

Cadência planejada:

| Job | Intervalo | Descrição |
|---|---|---|
| `refresh_token` | A cada 5 horas | Renova o access token OAuth |
| `sync_inventory` | A cada 2 horas | Atualiza estoque dos anúncios em lotes de 5 |
| `sync_visits` | 02:00 (1x/dia) | Sincroniza visitas dos itens |
| `sync_performance` | 03:00 (1x/dia) | Sincroniza métricas de performance |
| `sync_items` | 04:00 (1x/dia) | Sincroniza catálogo completo de anúncios |

---

## Checklist de testes

### Infraestrutura
- [ ] PostgreSQL acessível e banco criado
- [ ] Redis rodando e acessível
- [ ] `npm start` sem erros no Terminal 1
- [ ] `npm run worker` sem erros no Terminal 2
- [ ] `GET /health` retorna `{"ok":true}`

### Webhook
- [ ] `POST /webhooks/ml` com payload de pedido retorna 200 imediato
- [ ] Job aparece em `/api/webhooks/logs` com `status: pending`
- [ ] Worker processa e atualiza para `status: processed`
- [ ] Evento `order_updated` chega no WebSocket

### Dashboard
- [ ] `GET /api/dashboard/kpis` retorna JSON válido
- [ ] Dashboard abre no browser e exibe dados do banco
- [ ] Indicador de WebSocket muda para "ao vivo" (verde)
- [ ] Ao enviar webhook de pedido, KPIs atualizam sem reload

### Páginas
- [ ] Pedidos — lista com filtro por status e data
- [ ] Anúncios — busca e filtro por status
- [ ] Perguntas — responder via interface atualiza banco
- [ ] Curva ABC — gráfico gerado a partir de dados reais

---

## Variáveis de ambiente — Referência completa

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não (padrão: 3000) | Porta do servidor HTTP |
| `DATABASE_URL` | Sim | URL de conexão PostgreSQL |
| `REDIS_URL` | Não (padrão: redis://localhost:6379) | URL do Redis |
| `ML_CLIENT_ID` | Sim | Client ID do App no ML |
| `ML_CLIENT_SECRET` | Sim | Client Secret do App no ML |
| `ML_REDIRECT_URI` | Sim | URI de callback OAuth |
| `TELEGRAM_BOT_TOKEN` | Não | Token do bot para alertas |
| `TELEGRAM_CHAT_ID` | Não | Chat ID para receber alertas |

---

## Problemas comuns

**Worker não processa jobs:**
```bash
# Verifique se o Redis está rodando
redis-cli ping
# Deve retornar: PONG
```

**Erro de conexão com PostgreSQL:**
```bash
# Teste a conexão manualmente
psql $DATABASE_URL -c "SELECT 1"
```

**WebSocket não conecta:**
- Verifique se o servidor está rodando (`npm start`)
- Confirme que `ml_ws_url` no localStorage aponta para o host correto
- Default: `ws://localhost:3000/ws`

**Dashboard não mostra dados:**
- Confirme que o backend está rodando
- Verifique no console do browser se há erros de CORS ou 404
- Certifique-se que `ml_backend_url` no localStorage está correto
- Default: `http://localhost:3000/api`

---

## Licença

Proprietário — souzashopping.online
