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
  tableExport.js                     ← `exportTableCSV(table, filename)` genérico — lê qualquer <table> do DOM (thead/tbody) e baixa CSV; e `downloadCSVRows(rows, filename)` data-driven (matriz de linhas já em memória) pra grids paginadas no servidor, onde o DOM só tem a página atual (ex.: Extrato da conta com `all=1`)
  api.js                             ← LEGADO — cliente direto da API do ML, não usar
```

## Exportação CSV das tabelas

Toda página de relatório/listagem cuja tabela principal seja um `<table class="data-table">` real (não card/list) tem um botão `.action-btn` no `card-header` chamando `exportTableCSV(document.getElementById('<tbodyId>').closest('table'), '<nome>.csv')` — inclui `js/tableExport.js` logo após `db.js`. Páginas com exportador dedicado (`analise-vendas-mes`, `devolucoes`, `vendas-turbo`, `top-vendas-online` — CSV/PDF via jsPDF) mantêm sua própria função em vez do utilitário genérico. Páginas card/list-based (`alteracoes`, `estoque-parado`, `lojas`, `mensagens`, `perguntas`, `periodo`, `performance` — lista de produtos, não tabela) e páginas de config/monitor (`monitor`, `schedule`, `login`) ficam fora deste padrão.

## Páginas (`pages/`)

Agrupadas pelas seções de navegação definidas em `NAV_ITEMS` (`js/layout.js`):

- **Início**: top-vendas-online (dashboard matinal "morning digest" — consolida em cards/gráficos coloridos o que já vai por Telegram/e-mail: top vendas últimas 4h — mesmo dado do alerta Telegram, via `GET /api/schedule/runs?job=top-vendas`, auto-refresh 4h —, resumo do dia anterior, top vendas do dia 24h (com botões CSV/PDF — `dlTopDiaCSV()`/`dlTopDiaPDF()`, 100% client-side, sem rota nova; PDF via jsPDF carregado sob demanda do CDN, mesmo padrão de `vendas-turbo.html` simplificado pra 1 tabela), relatório semanal; usa Chart.js, sem rota exclusiva além de `GET /api/dashboard/resumo-ontem`/`top-vendas-dia`/`resumo-semanal`, ver `api.md`), agenda-trello (quadro Kanban de tarefas do Analista de E-commerce — ver seção dedicada abaixo e `task-engine.md`)
- **Operação**: anuncios, pedidos, embalagem (bipagem de etiqueta + vídeo de conferência — ver seção dedicada abaixo e `embalagem.md`), vendas, vendas-por-loja, promocoes, perguntas, mensagens, clientes, lojas
- **Análises**: horarios, diasemana, produtos, performance, estoque-parado, publicidade, concorrentes
- **Comparativos**: periodo, evolucao, curvaABC, analise-vendas-mes (BI — comparativo mensal, média histórica 12 meses, heatmap, rankings, insights automáticos e drill-down por dia; usa Chart.js, mesmo padrão do `dashboard.js`)
- **Alertas**: reposicao, cancelamentos, devolucoes, anuncios-problema, qualidade-anuncio (SEO Score determinístico por anúncio — filtros loja/categoria/marca/tipo logístico/FULL/catálogo, 7 KPIs, gráfico de evolução do score médio (7/30/90 dias), rankings Top10/Piores10 calculados no cliente a partir da mesma lista, tabela com ícones de auditoria (GTIN/vídeo/catálogo/atributos) — ver `GET /api/qualidade-anuncio*` em `api.md`, `item_seo_score` em `database.md`, job `sync-seo-score` em `workers.md`, decisão da fórmula/pesos em `decisions.md`), alteracoes
- **Financeiro**: vendas-turbo (dashboard da planilha Vendas ML Turbo — ver `finance.md`), conciliacao-bancaria (Agenda de Recebimentos — cards Hoje/Amanhã/7 dias/30 dias calculados no cliente a partir de `GET /api/conciliacao/agenda-recebimentos`, tabela dia-a-dia com export CSV; ver `conciliacao-bancaria.md`)
- **Sistema**: mcp (chat com IA), monitor (métricas de servidor + config Telegram), schedule (jobs agendados), webhook (logs de webhooks recebidos)

Fora desse agrupamento (não usam `NAV_ITEMS`/sidebar ML — têm sidebar própria por marketplace, ver `js/layout-amazon.js`/`js/layout-shopee.js` abaixo): `dashboard-amazon`, `amazon-vendas`, `amazon-pedidos`, `amazon-produtos`, `amazon-anuncios` (dashboards dedicados da Amazon), `dashboard-shopee` (dashboard dedicado da Shopee, mesmo padrão — ver `shopee.md`).

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

`DB.getTasks(params)`/`getTasksSummary()`/`createTask(body)`/`updateTask(id, body)`/`deleteTask(id)`/`getTaskComments(id)`/`addTaskComment(id, body)` — Agenda Trello (`/api/tasks/*`, ver `api.md`/`task-engine.md`), seguem o padrão genérico `_get`/`_post`/`_patch`/`_delete` (sem exceção de tratamento de erro).

**Exceção ao padrão `_post`/`_patch`**: esses dois helpers descartam o corpo da resposta em erro e retornam `null` (o chamador só sabe que falhou, não por quê). `DB.getLojasAmazon()`, `DB.addLojaAmazon(data)` e `DB.deleteLojaAmazon(id)` (endpoints em `api.md`, seção "Lojas") **não** usam `_post`/`_patch` — implementam o próprio `fetch` (mesmo padrão de `_get`) para preservar `{ error: "mensagem" }` do backend mesmo em resposta não-OK, porque `pages/lojas.html` precisa mostrar esse texto exato dentro do modal de cadastro em vez de um erro genérico. Qualquer método novo que precise repassar a mensagem de erro do backend ao usuário deve seguir esse mesmo padrão, não `_post`/`_patch`.

## `pages/lojas.html` — modal "Adicionar loja" (multi-marketplace)

O grid principal da página (`#lojasGrid`) mostra só lojas ML (`DB.getLojas()`, view `ml_stores` — ver `api.md`). O botão "+ Adicionar loja" abre um modal (`#addLojaModal`, mesmo padrão visual do modal de detalhe de `pages/produtos.html`: overlay fixo `rgba(0,0,0,.7)` + blur, fecha ao clicar fora) com três opções renderizadas dentro de `#addLojaModalBody`, trocadas via funções JS (sem navegação de página):

- `renderLojaChoice()` — tela inicial com os 3 botões (`.add-loja-option`).
- **Mercado Livre** → mantém o comportamento antigo do botão: navega para `/auth/login` (fluxo OAuth, ver `mercadolivre.md`).
- **Amazon** → `renderAmazonForm()`: formulário (`nickname`, `refresh_token` como `input type="password"`, `amazon_marketplace_id` opcional, `amazon_region` opcional) que chama `DB.addLojaAmazon(data)` (`submitAmazonForm()`). Sucesso: fecha o modal, `alert()` com o campo `note` da resposta (aviso de que o worker precisa reiniciar — ver `api.md`/`decisions.md`), recarrega `#amazonGrid`. Erro: mensagem exibida dentro do próprio modal (`#az-error`), modal permanece aberto para o usuário corrigir.
- **Shopee** → `renderShopeeInfo()`: só um aviso informativo (integração aguardando aprovação do app, ver `shopee.md`) e um botão "Salvar" desabilitado — sem formulário nem submit.

Abaixo do grid ML existe uma segunda seção, "Contas Amazon" (`#amazonGrid`, populada por `loadContasAmazon()` via `DB.getLojasAmazon()`), com nickname, se tem `refresh_token` configurado, marketplace ID/região (ou "padrão do .env") e um botão remover que pede `confirm()` antes de chamar `DB.deleteLojaAmazon(id)`. Estado vazio: "Nenhuma conta Amazon cadastrada ainda." Reaproveita a mesma classe `.loja-card` do grid ML para não duplicar visual.

Qualquer página nova que precise de um modal de escolha/formulário deve reaproveitar esse mesmo padrão (overlay + card centralizado + `innerHTML` trocado por função) em vez de criar um componente do zero — não existe um `modal.css` genérico no projeto, cada página estiliza o próprio modal inline, seguindo esse exemplo.

## Alternador de marketplace (Mercado Livre / Amazon / Shopee) — `.mkt-switcher-compact`

Todo o sistema é multi-marketplace, mas cada marketplace tem seu **dashboard e layout completamente independentes** — nenhuma página de um marketplace usa o menu lateral (sidebar) de outro. A navegação entre eles é só pelos 3 botões `.mkt-switcher-compact` (CSS em `css/style.css`, ao lado das regras de `.topbar`) que aparecem no **topbar**, canto superior direito, em **toda página do sistema**, ML incluído:

- Nas páginas ML (`pages/*.html`, via `js/layout.js`): `buildTopbar()` (`js/layout.js`) chama `buildMarketplaceSwitcher()` e injeta o resultado no início de `.topbar-right`, ao lado do seletor de loja. Não mexe em `NAV_ITEMS`/sidebar — é só um link de saída no topbar, a sidebar ML continua exatamente a mesma em todas as páginas ML.
- Em `index.html` (dashboard ML, que tem topbar/sidebar hardcoded, não usa `js/layout.js`): o mesmo markup do switcher foi inserido manualmente em `.topbar-right`.
- `href`s relativos: de `pages/*.html` → `../index.html` (Mercado Livre), `dashboard-amazon.html`, `dashboard-shopee.html`. De `index.html` (raiz) → `index.html`, `pages/dashboard-amazon.html`, `pages/dashboard-shopee.html`.

Convenção de nome para dashboards dedicados por marketplace: `dashboard-<marketplace>.html`. `dashboard-ml.html` ainda não existe — o botão "Mercado Livre" aponta para o `index.html` atual.

## `js/layout-amazon.js` — sidebar e topbar exclusivos da Amazon

Igual em espírito a `js/layout.js`, mas **exclusivo das páginas Amazon** — nunca incluído por página ML nenhuma, e `js/layout.js` nunca é incluído pelas páginas Amazon. Cada marketplace tem seu próprio menu lateral; o da Amazon nunca aparece numa página ML e vice-versa (regra explícita do usuário — cada loja/marketplace é uma área independente).

- `AMAZON_NAV_ITEMS`: Dashboard (`dashboard-amazon.html`), Vendas Totais (`amazon-vendas.html`), Pedidos (`amazon-pedidos.html`), Produtos (`amazon-produtos.html`), Anúncios (`amazon-anuncios.html`).
- `buildAmazonSidebar()`/`buildAmazonTopbar()` reaproveitam as mesmas classes CSS de `css/sidebar.css`/`css/style.css` que a sidebar ML usa (`.sidebar`, `.nav-item`, `.topbar`, etc.) — só troca a lista de itens e a cor de destaque (laranja `#ff9900`, identidade Amazon) — não duplica CSS.
- O topbar da Amazon já inclui o switcher `.mkt-switcher-compact` (Mercado Livre/Amazon ativo/Shopee) e um botão de refresh (`#btnRefresh`), igual ao padrão ML.
- Injeta em `<div id="app-sidebar">`/`<div id="app-topbar">` dentro de um `document.addEventListener('DOMContentLoaded', ...)` — **qualquer script inline da página que dependa desses elementos (ex.: `#btnRefresh`) também precisa rodar dentro de um `DOMContentLoaded` próprio**, registrado depois da tag `<script src="../js/layout-amazon.js">`, para garantir que o elemento já exista (scripts síncronos executam antes do evento `DOMContentLoaded` disparar).
- Páginas que usam este layout incluem só `css/style.css` + `css/sidebar.css` + `css/cards.css` e, no JS, `js/db.js` + `js/websocket.js` + `js/layout-amazon.js` + `js/sidebar.js` (o `sidebar.js` de toggle mobile é genérico, reaproveitado sem alteração).

## `js/layout-shopee.js` — sidebar e topbar exclusivos da Shopee

Mesmo molde exato de `js/layout-amazon.js` (mesma função `document.addEventListener('DOMContentLoaded', ...)`, mesmas classes CSS reaproveitadas, cor de destaque própria — laranja Shopee `#ee4d2d`). `SHOPEE_NAV_ITEMS` hoje só tem **Dashboard** (`dashboard-shopee.html`) — páginas de detalhe (`shopee-vendas.html`/`shopee-pedidos.html`/`shopee-produtos.html`, mesmo padrão da Amazon) ficam pra quando pedidos reais de sandbox começarem a chegar (ver `todo.md`).

## `pages/dashboard-amazon.html`, `amazon-vendas.html`, `amazon-pedidos.html`, `amazon-produtos.html`, `amazon-anuncios.html` e `pages/dashboard-shopee.html`

Todas 100% isoladas do ML: Amazon busca dados só via `DB.getAmazonKpis()/getAmazonPedidos()/getAmazonProdutos()/getAmazonStatus()` (rotas `/api/amazon/*`), Shopee via `DB.getShopeeKpis()/getShopeePedidos()/getShopeeProdutos()/getShopeeStatus()` (rotas `/api/shopee/*`) — ver `api.md`. Nenhuma reutiliza `DB.getDashboardKPIs()`/`DB.getPedidos()`/etc. do ML.

- **`dashboard-amazon.html`** — visão geral: 3 cards de KPI (Vendas Totais/Pedidos — valores de hoje, já que `/api/amazon/kpis` só calcula o dia; Produtos ativos), tabela "Últimos pedidos Amazon", tabela "Produtos Amazon" (mostra a `note` do backend quando vazia), e card "Status da Integração" (última sincronização, último polling — mesmo valor de `marketplace_sync_state`, sem tracking granular separado ainda —, último erro, token conectado/desconectado por conta).
- **`amazon-vendas.html`** — card "Vendas Totais" (hoje) + card "Vendas Pagas" (contagem) + tabela de pedidos com `status='paid'` (filtro feito no cliente sobre `DB.getAmazonPedidos()` — não há endpoint de vendas agregadas por período para Amazon ainda, diferente do `vendas.html` do ML que tem margem calculada por venda; a Amazon não tem custo/imposto por pedido implementado).
- **`amazon-pedidos.html`** — tabela completa de pedidos com filtro de status (`<select>`, filtro no cliente).
- **`amazon-produtos.html`** — catálogo completo (`DB.getAmazonProdutos()`, sem filtro).
- **`amazon-anuncios.html`** — só anúncios ativos (`DB.getAmazonProdutos({status:'active'})`). **Importante**: como a sincronização de catálogo Amazon ainda não existe (ver `todo.md`), hoje `amazon-produtos.html` e `amazon-anuncios.html` mostram o mesmo vazio — a distinção fica pronta para quando a Listings Items API da Amazon for integrada.
- Todas recarregam em tempo real escutando `WS.on('order_updated', ...)` filtrado por `payload.marketplace === 'AMAZON'` (evento publicado por `marketplaceEventWorker.js`), com fallback de polling a cada 60s e botão de refresh manual (`#btnRefresh`, no topbar do `layout-amazon.js`).
- **`pages/dashboard-shopee.html`** — mesma estrutura exata de `dashboard-amazon.html` (deixou de ser placeholder), usando `js/layout-shopee.js`: 3 KPIs, tabela "Últimos pedidos Shopee", tabela "Produtos Shopee" (nota explicando que o catálogo Shopee ainda não é sincronizado, ver `todo.md`), card "Status da Integração". Recarrega em tempo real via `WS.on('order_updated', ...)` filtrado por `payload.marketplace === 'SHOPEE'`.
- Quando `dashboard-ml.html` for criado no futuro, deve seguir esse mesmo padrão de independência (sidebar própria, sem misturar com a da Amazon/Shopee).

## `pages/agenda-trello.html` — Kanban (Agenda Trello)

Página independente do resto do sistema — usa a mesma `NAV_ITEMS`/sidebar/topbar ML (`js/layout.js`), mas não lê nenhuma tabela `orders`/`items` diretamente, só `DB.getTasks*`/`DB.*Task*` (`/api/tasks/*`, ver `api.md`). Regras de negócio (quando um cartão automático é criado) ficam inteiramente em `taskEngine.js`, não na página — ver `task-engine.md`.

- **Painel superior**: 5 cards (Total, Pendentes, Em andamento, Finalizadas hoje, Críticas) via `DB.getTasksSummary()`.
- **Filtros**: Marketplace, Loja (`DB.getLojas()` — só lista lojas ML, mesma limitação do restante do sistema hoje), Responsável, Prioridade, Origem, Período (data de/até) — todos viram query params de `DB.getTasks(params)`.
- **Quadro**: 4 colunas fixas (`a_fazer`/`em_andamento`/`finalizado`/`excluido`), cada uma com contador e scroll independente. Cartões (`.at-card`) mostram título, badge de prioridade (cor por prioridade), loja, prazo (destaque vermelho se atrasado e ainda aberto), tags e responsável. Quando `metadata.link` existe (cartões automáticos), o título do cartão já é um link direto pro anúncio (`target="_blank"`, `event.stopPropagation()` pra não abrir o modal de detalhe ao clicar nele).
- **Status visível sem abrir o cartão**: um bloco (`.at-card-status`) no rodapé de cada card mostra "Atualizado \<data/hora\>" (`updated_at`, sempre), "Concluído \<data/hora\>" (`completed_at`, só quando o cartão está em Finalizado — é limpo pelo `PATCH` sempre que sai dessa coluna) e, se houver comentários, a contagem + prévia truncada (46 caracteres) do último comentário (`comment_count`/`last_comment_text` vindos do backend). Dá pra ter uma ideia do andamento só olhando o quadro, sem abrir o modal de detalhe.
- **Drag-and-drop**: API nativa HTML5 (`draggable`, `dragstart`/`dragover`/`drop`) — sem lib externa, mesmo padrão "vanilla JS sem bundler" do resto do frontend. Ao soltar um cartão em outra coluna, atualiza o estado local (otimista) e chama `DB.updateTask(id, { board_column })`.
- **Modal "+ Nova tarefa"**: cria cartão manual (`DB.createTask`) — Título, Descrição, Marketplace, Loja, Prioridade, Prazo, Responsável, Tags.
- **Modal de detalhe/edição**: abre ao clicar num cartão — mostra origem/loja/link do anúncio (se `metadata.link` existir, vindo de um cartão automático), permite editar todos os campos + mover de coluna, e lista/adiciona comentários (`DB.getTaskComments`/`DB.addTaskComment`). Dois blocos informativos somam-se aos campos editáveis: `basicInfoHtml()` (Criado em/Última atualização/Concluído em — em **todo** cartão, manual ou automático) e `autoInfoHtml()` (SKU/quantidade ou score atual/lista de problemas — só em cartões automáticos, que têm esses campos em `metadata`; cartões manuais não mostram esse segundo bloco).
- **Comentários**: lista com scroll próprio (`max-height: 260px`, independente do resto do modal), layout flexbox (avatar com inicial + cabeçalho autor/data + corpo do texto) — não usa `float` (bug corrigido: comentário sem espaços expandia o modal horizontalmente por falta de `word-break`/`overflow-wrap`). Emoji picker nativo (`EMOJI_LIST`, sem lib externa) ao lado do campo de texto, mesmo padrão "vanilla JS sem bundler" do resto do projeto.
- **Escape de HTML**: todo texto de entrada do usuário (título/tags/responsável de cartão, autor/texto de comentário) passa por `escapeHtml()` antes de virar `innerHTML` — sem isso, um comentário ou tag com `<script>`/`<img onerror=...>` executaria no navegador de qualquer um que abrisse aquele cartão (stored XSS). Campos que só vão para `.value` de `<input>`/`<textarea>` (edição) não precisam disso — só interpolação direta em `innerHTML`.
- **Notificação em tempo real**: `WS.on('task_created', ...)` (payload publicado por `worker.js` quando o TaskEngine cria — não só atualiza — um cartão automático) mostra um toast e recarrega o quadro/painel.
- **Exclusão definitiva**: botão "Excluir permanentemente" no modal de detalhe só fica visível quando o cartão já está na coluna Excluído (`t.board_column === 'excluido'`) — em qualquer outra coluna, mover pra "Excluído" é reversível (soft, via `board_column`); só de lá dá pra apagar de vez (`DB.deleteTask`, com confirmação via `confirm()`).
- **Checklist por cartão**: não implementado (explicitamente adiado, ver `task-engine.md`).

## `pages/embalagem.html` — bipagem de etiqueta + vídeo de conferência

Página operacional (pensada pra rodar num PC/tablet fixo na bancada de embalagem, com leitor de código de barras 2D USB/Bluetooth conectado — ver `embalagem.md` pra detalhes do formato da etiqueta). Três abas:

- **Bipar**: campo de bipagem sempre em foco (reforçado automaticamente); máquina de estado `idle → loading → recording → saving → idle`. Ao identificar o pedido via `DB.getPedidoPorEtiqueta(shippingId)`, mostra imagem/título grandes e **quantidade em destaque** (maior que o resto — pedido explícito do usuário), comprador menor, e liga a câmera (`getUserMedia`+`MediaRecorder`, permissão pedida assim que a página carrega). Bipar de novo a mesma etiqueta finaliza e salva (`DB.finalizarEmbalagem`, multipart); bipar uma etiqueta diferente enquanto grava pede confirmação (`confirm()`) antes de trocar.
- **Buscar vídeos**: filtro por pedido/comprador/data (`DB.getVideosEmbalagem`), player HTML5 num modal (`src` = `DB.videoEmbalagemUrl(id)`, que aponta pra `GET /api/embalagem/videos/:id/file` — suporta `Range`, então dá pra avançar/voltar sem baixar o vídeo inteiro).
- **Conferência do Dia**: mesma listagem/modal da aba anterior, sempre travada no dia corrente por padrão (campo de data editável). Cards de resumo (bipados no dia, Flex, Mercado Envios, por loja) calculados no frontend sobre a mesma resposta de `GET /videos`. Gráfico de colunas Chart.js (dia selecionado vs. dia anterior, por hora) via `DB.getEmbalagemPorHora`. Ver `embalagem.md`.

`DB.getPedidoPorEtiqueta(shippingId)`/`finalizarEmbalagem(formData)`/`getVideosEmbalagem(params)`/`videoEmbalagemUrl(id)`/`getEmbalagemPorHora(params)` — `finalizarEmbalagem` usa `DB._postForm()` (helper próprio, `fetch` com `FormData` cru, sem `Content-Type` manual — o navegador define o boundary do multipart sozinho; diferente do `_post` padrão, que sempre serializa `JSON.stringify`).

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
