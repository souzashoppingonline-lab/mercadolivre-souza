# Frontend

> Escopo: o frontend estático (HTML/CSS/JS sem build step) — sua estrutura, convenções e os módulos JS compartilhados. Para a lista de endpoints que `db.js` consome ver `api.md`. Para os tópicos WebSocket ver `websocket.md`.

## Stack

HTML puro + CSS + JS vanilla, sem bundler/framework. Bibliotecas externas via CDN: Font Awesome (ícones) e Chart.js (gráficos, usado em `dashboard.js` e páginas de análise).

## Estrutura

```
index.html         ← Dashboard principal (KPIs do dia, gráfico de vendas, alertas, top produtos)
pages/*.html        ← uma página por área funcional (ver lista completa abaixo)
css/
  style.css          ← tema/variáveis globais, layout base
  sidebar.css          ← sidebar + topbar
  cards.css              ← componentes de card/KPI
js/
  db.js                   ← ÚNICO ponto de acesso a dados (todas as chamadas /api/*)
  websocket.js              ← cliente WS singleton `WS`, auto-reconexão, heartbeat
  layout.js                  ← injeta sidebar/topbar, seletor de loja, alertas globais
  sidebar.js                   ← toggle mobile/desktop
  dashboard.js                   ← lógica específica do index.html
  webhook.js                       ← lógica específica de pages/webhook.html
  api.js                             ← LEGADO — cliente direto da API do ML, não usar
```

## Páginas (`pages/`)

Agrupadas pelas seções de navegação definidas em `NAV_ITEMS` (`js/layout.js`):

- **Operação**: anuncios, pedidos, vendas, vendas-por-loja, promocoes, perguntas, mensagens, metricas, clientes, lojas
- **Análises**: horarios, diasemana, produtos, performance, estoque-parado, publicidade, concorrentes
- **Comparativos**: periodo, evolucao, curvaABC
- **Alertas**: reposicao, cancelamentos, devolucoes, anuncios-problema, alteracoes
- **Financeiro**: vendas-turbo (dashboard da planilha Vendas ML Turbo — ver `finance.md`)
- **Sistema**: mcp (chat com IA), monitor (métricas de servidor + config Telegram), schedule (jobs agendados), webhook (logs de webhooks recebidos)

## Padrão de nova página (contrato)

1. Copiar a estrutura de uma página existente (ex.: `pages/pedidos.html`).
2. Definir `window.PAGE_TITLE` e `window.ACTIVE_NAV` **antes** de incluir `layout.js`.
3. Buscar dados exclusivamente via `DB.*` (`js/db.js`) — nunca `ML_API.*` (`js/api.js`, legado) nem `fetch` direto para `api.mercadolibre.com`.
4. Registrar listeners `WS.on('topic', handler)` para os tópicos relevantes (ver `websocket.md`) e atualizar a UI em tempo real.
5. Adicionar o link em `NAV_ITEMS` (`js/layout.js`).

Sempre que uma página nova é criada seguindo este contrato, `frontend.md` deve ganhar uma linha na lista de páginas acima.

## `js/db.js` — camada de dados

Objeto `DB` com um método por endpoint (`DB.getDashboardKPIs()`, `DB.getPedidos(params)`, etc.), todos implementados sobre três helpers genéricos: `_get`, `_patch`, `_post`. Base URL configurável via `localStorage.ml_backend_url` (padrão `/api`). Nunca lança exceção para o chamador — em erro retorna `{ error: mensagem }` ou `null`, então toda página deve checar o retorno antes de usar.

Ao adicionar um endpoint novo em `routes/api.js`, adicionar o método correspondente em `db.js` na mesma tarefa — a documentação em `api.md` deve ser atualizada junto.

**Exceção ao padrão `_post`/`_patch`**: esses dois helpers descartam o corpo da resposta em erro e retornam `null` (o chamador só sabe que falhou, não por quê). `DB.getLojasAmazon()`, `DB.addLojaAmazon(data)` e `DB.deleteLojaAmazon(id)` (endpoints em `api.md`, seção "Lojas") **não** usam `_post`/`_patch` — implementam o próprio `fetch` (mesmo padrão de `_get`) para preservar `{ error: "mensagem" }` do backend mesmo em resposta não-OK, porque `pages/lojas.html` precisa mostrar esse texto exato dentro do modal de cadastro em vez de um erro genérico. Qualquer método novo que precise repassar a mensagem de erro do backend ao usuário deve seguir esse mesmo padrão, não `_post`/`_patch`.

## `pages/lojas.html` — modal "Adicionar loja" (multi-marketplace)

O grid principal da página (`#lojasGrid`) mostra só lojas ML (`DB.getLojas()`, view `ml_stores` — ver `api.md`). O botão "+ Adicionar loja" abre um modal (`#addLojaModal`, mesmo padrão visual do modal de detalhe de `pages/produtos.html`: overlay fixo `rgba(0,0,0,.7)` + blur, fecha ao clicar fora) com três opções renderizadas dentro de `#addLojaModalBody`, trocadas via funções JS (sem navegação de página):

- `renderLojaChoice()` — tela inicial com os 3 botões (`.add-loja-option`).
- **Mercado Livre** → mantém o comportamento antigo do botão: navega para `/auth/login` (fluxo OAuth, ver `mercadolivre.md`).
- **Amazon** → `renderAmazonForm()`: formulário (`nickname`, `refresh_token` como `input type="password"`, `amazon_marketplace_id` opcional, `amazon_region` opcional) que chama `DB.addLojaAmazon(data)` (`submitAmazonForm()`). Sucesso: fecha o modal, `alert()` com o campo `note` da resposta (aviso de que o worker precisa reiniciar — ver `api.md`/`decisions.md`), recarrega `#amazonGrid`. Erro: mensagem exibida dentro do próprio modal (`#az-error`), modal permanece aberto para o usuário corrigir.
- **Shopee** → `renderShopeeInfo()`: só um aviso informativo (integração aguardando aprovação do app, ver `shopee.md`) e um botão "Salvar" desabilitado — sem formulário nem submit.

Abaixo do grid ML existe uma segunda seção, "Contas Amazon" (`#amazonGrid`, populada por `loadContasAmazon()` via `DB.getLojasAmazon()`), com nickname, se tem `refresh_token` configurado, marketplace ID/região (ou "padrão do .env") e um botão remover que pede `confirm()` antes de chamar `DB.deleteLojaAmazon(id)`. Estado vazio: "Nenhuma conta Amazon cadastrada ainda." Reaproveita a mesma classe `.loja-card` do grid ML para não duplicar visual.

Qualquer página nova que precise de um modal de escolha/formulário deve reaproveitar esse mesmo padrão (overlay + card centralizado + `innerHTML` trocado por função) em vez de criar um componente do zero — não existe um `modal.css` genérico no projeto, cada página estiliza o próprio modal inline, seguindo esse exemplo.

## `js/layout.js` — sidebar, topbar e alertas globais

- Injeta `<aside class="sidebar">` e `<header class="topbar">` a partir de `NAV_ITEMS`.
- **Seletor de loja** (`storeSwitcher`): busca `DB.getLojas()`, guarda a loja ativa em `localStorage.ml_active_store`, dispara `window.dispatchEvent(new CustomEvent('storeChanged', { detail: { storeId, storeName } }))` — páginas que filtram por loja devem escutar esse evento.
- **Alertas globais** (`initAlerts`): toca um beep (Web Audio API, sem arquivo externo) e mostra um toast + notificação nativa do browser quando chegam os eventos WS `question_received` (status `UNANSWERED`) e `message_received`. Também injeta um badge vermelho no link "Perguntas" da sidebar.
- Pede permissão de `Notification` do browser automaticamente ao carregar (se ainda não decidido).

## `js/websocket.js` — cliente WS

Objeto `WS` singleton, conecta automaticamente ao carregar o script (`WS.connect()` no final do arquivo). Reconexão com backoff exponencial (2s → 30s máx). Heartbeat de ping/pong a cada 25s com timeout de 60s (força reconexão se não houver pong). API: `WS.on(topico, fn)`, `WS.off(...)`, tópico especial `'*'` recebe tudo. Detalhes de cada tópico emitido pelo backend: `websocket.md`.

## Configuração via `localStorage`

| Chave | Padrão | Descrição |
|---|---|---|
| `ml_backend_url` | `/api` | base da REST API |
| `ml_ws_url` | `wss://HOST/ws` ou `ws://HOST/ws` (auto-detectado por protocolo) | URL do WebSocket |
| `ml_active_store` | `''` (todas as lojas) | loja selecionada no seletor da topbar |
| `ml_token` | — | usado apenas por `js/api.js` (legado, não usar em páginas novas) |

## `js/api.js` — por que existe e por que não usar

Cliente HTTP cru que fala direto com `api.mercadolibre.com` usando um token salvo em `localStorage`. É resquício de uma versão anterior (não-EDA) do projeto. Mantido só como referência de payloads da API do ML. Importá-lo em uma página nova viola a regra arquitetural #1 de `architecture.md`.
