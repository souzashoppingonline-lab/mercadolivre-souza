# TODO

> Lista viva de itens acionáveis e concretos — granularidade de tarefa, não de direção estratégica (`roadmap.md`) nem de defeito documentado sem plano de ação definido (`known-bugs.md`, embora todo item de `known-bugs.md` com "Correção esperada" definida vire candidato natural a entrar aqui). Marque `[x]` ao concluir e mova o resultado relevante para `decisions.md`/`database.md`/etc. conforme o caso. Adicione itens novos sempre que uma tarefa ficar pendente ao final de uma sessão.

## Integração Amazon — v15 conectada, falta validar em sandbox e depois produção

- [x] Confirmar a decisão de schema — coluna `marketplace_id` discriminadora, sem normalização profunda (ver `decisions.md`).
- [x] Credenciais `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET`/`AMAZON_MARKETPLACE_ID`/`AMAZON_REGION` já configuradas em `server/.env`.
- [x] Primeiro corte usa polling periódico (`AmazonPollingEventSource`, 15 min) — Notifications API (SNS/SQS) fica como evolução futura se o polling não escalar.
- [x] Migration (`migrate-v15.sql`), worker/fila dedicado (`marketplaceEventWorker.js`), `database.md`/`workers.md`/`amazon.md` atualizados.
- [x] Validado em produção que `AmazonPollingEventSource` roda e dispara o polling a cada 15 min.
- [x] Corrigido: sandbox estático exige literais fixos documentados (`CreatedAfter=TEST_CASE_200`/`MarketplaceIds=ATVPDKIKX0DER` em `listRecentOrders`; `orderId=TEST_CASE_200` no path de `getOrder`) — confirmado no modelo oficial `ordersV0.json`. Ambos aplicados em `amazonClient.js`.
- [x] Criado `MockEventSource`/`MockClient` (`AMAZON_ENV=mock`) para desenvolver/testar dashboard/KPIs sem depender do sandbox estático (que sempre devolve o mesmo pedido fixo) — ver `amazon.md`.
- [x] Confirmado em produção que o pedido de teste do `TEST_CASE_200` chega até `orders`/`amazon_order_data` de ponta a ponta (`✅ nova venda Amazon: 902-1845936-5435065 | R$ 11.01`).
- [x] Testado `AMAZON_ENV=mock` em produção — pedido fabricado (`MOCK-924-4509518-5060956`) passou pela fila e foi gravado em `orders`/`amazon_order_data` corretamente.
- [x] **Banco e backend preparados para múltiplas contas Amazon/Shopee (v16)** — `stores` guarda uma linha por conta, `marketplaceEventWorker.js` registra uma `EventSource`/`client` por conta, eventos carregam `storeId` como chave de roteamento. Ver `decisions.md` ("Marketplace Engine — múltiplas contas por marketplace").
- [x] **Rotas REST/admin para cadastrar conta Amazon** — `GET/POST/DELETE /api/lojas/amazon` (v17, ver `api.md`), sem precisar `INSERT` manual.
- [x] **Contaminação de KPIs/relatórios do ML corrigida (v17)** — views `vw_ml_orders`/`vw_ml_items`/`vw_ml_stores`, `routes/api.js` lê delas. Ver `database.md`/`decisions.md`.
- [x] Modal "Adicionar loja" (Mercado Livre/Amazon/Shopee) na página Lojas do frontend, usando as rotas acima para Amazon.
- [x] **Dashboard dedicado Amazon (`pages/dashboard-amazon.html`)** — cards Vendas Totais/Pedidos/Produtos, tabelas de pedidos e produtos, card Status da Integração; rotas próprias `/api/amazon/*` (ver `api.md`). Página independente: sem sidebar ML, sem `js/layout.js`. `pages/dashboard-shopee.html` criado como placeholder (Shopee ainda bloqueada), mesmo padrão independente. Ver `frontend.md`.
- [x] **Menu lateral próprio da Amazon (`js/layout-amazon.js`)** — Dashboard/Vendas Totais/Pedidos/Produtos/Anúncios, com páginas dedicadas (`amazon-vendas.html`, `amazon-pedidos.html`, `amazon-produtos.html`, `amazon-anuncios.html`). Nunca aparece numa página ML, e a sidebar ML nunca aparece numa página Amazon. `GET /api/amazon/produtos?status=active` filtra anúncios ativos. Ver `frontend.md`.
- [x] **Alternador de marketplace (`.mkt-switcher-compact`) no topbar de toda página** — Mercado Livre/Amazon/Shopee, sempre no canto superior direito, para trocar de marketplace de qualquer tela sem passar pela sidebar. Injetado por `js/layout.js` em toda página ML e hardcoded em `index.html`; cada dashboard dedicado (`dashboard-amazon.html`/`dashboard-shopee.html`) tem sua própria cópia no topbar independente. Ver `frontend.md`.
- [ ] `dashboard-ml.html` dedicado (hoje o botão "Mercado Livre" do switcher aponta para `../index.html`, o dashboard ML existente) — só criar se/quando fizer sentido separar do `index.html` atual.
- [ ] Dashboard unificado "visão geral" (`dashboard.html`, todos os marketplaces juntos: Receita Total, Pedidos Totais, Produtos Totais, Anúncios Ativos) — explicitamente deixado para depois pelo usuário.
- [ ] Hot-reload de contas Amazon no worker — hoje uma conta cadastrada via `POST /api/lojas/amazon` só é sincronizada depois de reiniciar `ml-worker-novo` manualmente.
- [ ] Validar se `mapAmazonStatus()` (`marketplaceEventWorker.js`) está mapeando `OrderStatus` da Amazon para `orders.status` de forma sensata — só dá pra confirmar de fato quando pedidos reais começarem a chegar.
- [ ] Dashboard multi-marketplace de verdade (ML+Amazon juntos) — hoje as telas continuam ML-only por padrão (views `ml_*`); unificar é decisão de produto/UX futura, não bloqueia o uso atual.
- [ ] Sincronizar catálogo de produtos Amazon (Listings Items API do SP-API) — hoje `items` só é populada indiretamente via pedido (nenhum produto sem venda aparece); `amazon-produtos.html` e `amazon-anuncios.html` mostram o mesmo vazio até isso existir.
- [ ] Notificação Telegram de vendas Amazon (fora de escopo até agora).
- [ ] Trocar `AMAZON_ENV` para `production` só depois de autorização de produção aprovada pela Amazon no Seller Central.

## Débito técnico — Marketplace Engine (v15/v16)

- [ ] Fase 2: normalização completa (`order_items`/`products`/`inventory`/`shipments`/`customers`) via Strangler Pattern, módulo a módulo — ver `roadmap.md`.
- [ ] Renomear `orders.ml_id` para algo marketplace-neutro (ex: `external_order_id`) — mantido por ora para não tocar em todo `api.js`/`worker.js`/frontend que já referenciam esse nome.
- [ ] Avaliar migrar `MercadoLivreEventSource`/`ShopeeEventSource` para o padrão `EventSource`/`Scheduler` — só depois que Amazon (e Shopee) provarem o padrão estável em produção (ver `decisions.md`).

## Integração Shopee — v18 conectada (fase 1), falta configurar produção e autorizar loja

- [x] Perfil de desenvolvedor aprovado pela Shopee Open Platform, ambiente sandbox liberado.
- [x] IP de saída do servidor (`207.180.194.61`, fixo) cadastrado na Lista de IPs Permitidos da Shopee.
- [ ] **BLOQUEADOR: Configurar credenciais de produção** (ver `known-bugs.md` item 11 — HTTP 403 na produção). Em `server/.env` do servidor:
  - `SHOPEE_PARTNER_ID=2039090` (app aprovado, partner ID live)
  - `SHOPEE_PARTNER_KEY=<chave live — nunca compartilhe>`
  - `SHOPEE_ENV=production` (não `sandbox`)
  - `SHOPEE_REDIRECT_URI=https://multimixvendas.duckdns.org/auth/shopee/callback`
  - Depois: reiniciar servidor + worker, rodar `node server/test-shopee-config.js` pra diagnosticar
- [x] `shopeeClient.js` real: assinatura HMAC-SHA256, OAuth completo (`getAuthorizationUrl`/`exchangeCodeForToken`/`refreshAccessToken`), `getOrder`/`listRecentOrders`.
- [x] Rotas OAuth `GET /auth/shopee/login`/`callback`/`config` (`routes/shopeeAuth.js`).
- [x] Migration v18: `marketplaces.SHOPEE` habilitado, `stores.shopee_shop_id`, tabela `shopee_order_data`.
- [x] `ShopeePollingEventSource` (polling 15min, mesmo padrão `AmazonPollingEventSource`) + segundo `Worker`/fila em `marketplaceEventWorker.js` (`handleShopeeOrderEvent`).
- [x] Renovação de token com CAS (Shopee rotaciona `refresh_token` a cada renovação — Amazon não).
- [ ] Autorizar a conta Shopee real via `/auth/shopee/login` (passo manual — usar a conta do usuário em produção) e reiniciar `ml-worker-novo`.
- [ ] Validar em produção que `ShopeePollingEventSource` roda e os pedidos reais chegam até `orders`/`shopee_order_data` de ponta a ponta, com `tracking_number` sincronizado assim que disponível (ver bipagem em `embalagem.md`).
- [ ] Confirmar no console Shopee se "Mecanismo de Empurra" é disponível e formato da assinatura — decidir se/quando migrar de polling para webhook (fase 2, ver `shopee.md`).
- [ ] Rota admin `GET/POST/DELETE /api/lojas/shopee` (listar/remover contas) — decisão consciente de não ter `POST` manual (a Shopee sempre exige OAuth completo, ver `decisions.md`), mas falta pelo menos `GET`/`DELETE` para gerência via UI, mesmo padrão de `/api/lojas/amazon`.
- [x] **Dashboard dedicado Shopee** (`pages/dashboard-shopee.html`) — mesmo padrão da Amazon (`js/layout-shopee.js`, rotas `/api/shopee/*`). Feito antes de ter pedido real de sandbox (a solicitação de produção da Shopee exigia uma URL ativa do produto) — tabelas ficam vazias até a loja de teste ser autorizada.
- [ ] Páginas de detalhe Shopee (`shopee-vendas.html`/`shopee-pedidos.html`/`shopee-produtos.html`, mesmo padrão de `amazon-vendas.html`/etc.) — fica pra quando pedidos reais de sandbox começarem a chegar e a tabela única do dashboard já não for suficiente.
- [x] **Papel de login `shopee-demo`** (restrito a `dashboard-shopee.html` + `/api/shopee/*`) — pra dar acesso ao revisor da Shopee Open Platform sem expor dado do Mercado Livre/financeiro/embalagem. Ver `auth-staff.md`/`decisions.md`. Falta só criar a conta de fato via `createStaffUser.js` (passo manual do usuário, credenciais não ficam no repositório).
- [ ] Sincronizar catálogo de produtos Shopee (Product API — `03-Products.md` da KB fornecida pelo usuário) — hoje só pedidos são sincronizados.
- [ ] Notificação Telegram de vendas Shopee (fora de escopo até agora, mesma decisão já tomada pra Amazon).
- [ ] Trocar `SHOPEE_ENV` para `production` só depois de aprovação de produção pela Shopee (em andamento — usuário preenchendo o formulário "Transmissão ao vivo" no console).

## Fase Shopee — melhorias e IA Sócio

Fase de expansão da Shopee, totalmente isolada do Mercado Livre (arquivos/rotas/páginas próprios, mesmo padrão de separação já adotado para Amazon).

### Já concluído (referência)

- [x] **Chat Shopee** — responder o cliente dentro da plataforma (`send_message`) + histórico da conversa (`get_message_list`). — v38
- [x] **Página Lojas Shopee** + renomear loja (o `nickname` renomeado é usado em relatórios e no chat).
- [x] **Webhook (Mecanismo de Empurra)** — handshake de verificação corrigido.
- [x] **Sync de Catálogo (Product API)** → popula `items` + `shopee_item_data` (job `syncShopeeCatalog`, a cada 30 min). — v39
- [x] **Página Anúncios real** — foto, variações, faixa de preço.
- [x] **Estoque & Preço em massa** — `update_price`/`update_stock`, por variação.
- [x] **Precificador** — custo por variação em `shopee_item_cost` (v40); taxa automática vinda do escrow.
- [x] **Promoções** — descontos/vouchers, prazos, contagem regressiva, alerta Telegram de vencimento (v41, job `syncShopeePromos`).
- [x] **Painel de Problemas** — atrasados, pausados, sem estoque, sem imagem, cancelados.

### Pendente desta fase

- [ ] **Dashboard Executivo Shopee** — KPIs de Hoje (Faturamento, Lucro, Pedidos, Ticket Médio, Margem), com custo editável integrado ao `shopee_item_cost`.
- [ ] **Performance de Anúncios Shopee** — tabela SKU / Pedidos / Faturamento / Lucro. Visitas e taxa de conversão dependem da **Shopee Data API** — rodar diagnóstico read-only para verificar se está liberada (pode exigir whitelist no console).
- [ ] **IA Sócio Shopee** — rota que monta o contexto (vendas por dia/loja, margem, estoque, promoções, problemas) e chama a API do Claude (`ANTHROPIC_API_KEY` já existe em `env`), com página de recomendações automáticas.
- [ ] **Reclamações/Reembolsos no Painel de Problemas** — dependem da **Returns API da Shopee** (ainda não integrada).

## Login de acesso restrito (staff) — código pronto, falta ativar em produção (ver `auth-staff.md`)

- [x] Migration v22 (`staff_users`), deps (`bcryptjs`/`jsonwebtoken`/`cookie-parser`), `routes/staffAuth.js` (login/logout/me + `requireStaffAuth`), `server.js` (cookie-parser + gate + `express.static` + fallback SPA), `pages/login.html`, `js/layout.js` (nav por papel + botão Sair), `server/scripts/createStaffUser.js`.
- [ ] **Trocar `location /` do nginx** de servir estático direto pra `proxy_pass http://127.0.0.1:3000;` — sem isso, o gate não protege carregamento de página (só `/api/*`). Procedimento e rollback em `deployment.md`.
- [ ] Rodar `node scripts/createStaffUser.js <usuário> <senha> admin` em produção pra criar o 1º usuário.
- [ ] Gerar `STAFF_JWT_SECRET` (`openssl rand -hex 32`), setar `STAFF_AUTH_ENABLED=true` no `.env` de produção, reiniciar `ml-dashboard-novo`.
- [ ] Testar login end-to-end em produção antes de considerar concluído (admin navega tudo normalmente; usuário `embalagem` só consegue abrir a página de Embalagem).
- [ ] Criar usuário(s) `embalagem` para os funcionários reais.

## Débito técnico registrado nesta tarefa

- [ ] Avaliar migrar `mlClient.js`/`routes/auth.js` para `server/src/marketplaces/mercadolivre/` seguindo o padrão `MarketplaceClient` — só depois que a Amazon estiver de fato funcionando em produção com esse padrão (ver `decisions.md`, "Marketplace Engine").
- [ ] Backfill de `orders.shipping_type` para pedidos históricos já gravados com o campo vazio — a correção em `handleOrder` (ver `decisions.md`) só resolve a logística de pedidos novos/reprocessados a partir de agora. Um job dedicado (throttled, sequencial, mesmo padrão de `syncVisitas`) que busca `/shipments/:id` para todo pedido antigo sem `shipping_type` resolveria o histórico, mas não foi feito por ser tarefa de escopo/risco de rate-limit diferente.

## Correções pendentes (originadas de `known-bugs.md`)

- [ ] Criar migration adicionando `questions.tg_message_id BIGINT` e incluí-la em `db/migrate.js` (item 1 de `known-bugs.md`) — sem isso, responder perguntas via reply no Telegram não persiste o vínculo.
- [ ] Incluir `migrate-v10.sql` (índice único `messages_pack_id_unique`) na lista de `db/migrate.js`, ou migrar seu conteúdo para `schema.sql` (item 4 de `known-bugs.md`).
- [ ] Decidir e documentar em `decisions.md`: remover o tópico WS `kpis_updated` (código morto) ou implementar sua publicação de fato (item 2 de `known-bugs.md`).
- [ ] Avaliar se `PATCH /api/custos/:sku` deveria exigir/validar que o `sku` informado é de fato um `ml_id` válido, ou desacoplar de vez `sku_costs` de `items.cost` (item 3 de `known-bugs.md`).

## Inteligência de Margem — Fase 3 (deliberadamente fora desta tarefa)

Fase 1 (motor determinístico) e Fase 2 (LLM narrativo + melhorias de analista) feitas. Tela dividida em 6 páginas (`bi-margem.html` + `bi-margem-produtos/portfolio/frete/estoque/acoes.html`, ver `modules.md`). Concluído nesta rodada:

- [x] ~~Camada de LLM escrevendo a narrativa em português~~ — `POST /api/bi/margem/narrativa` (`server/src/ai/margemNarrativa.js`), sob demanda, contexto reduzido, sem tabela de histórico ainda (ver abaixo).
- [x] ~~Simulação de preço multi-cenário (+3%/+5%/+10%)~~ — `cenarios[]` em cada ação `REPRECIFICAR`.
- [x] ~~Decomposição de causa raiz por variação de período~~ — implementada como identidade matemática exata (`resumo.causa_variacao`), não como aproximação percentual; indicador de mix separado. Ver `decisions.md`/`business-rules.md` pro porquê da abordagem diferente do pedido original.
- [x] ~~Tendência por SKU~~ (sugestão minha, aprovada) — sparkline de MC% últimas até 6 semanas, `tendencia_semanal[]`.
- [x] ~~Export CSV~~ (sugestão minha, aprovada) — tabelas Produtos e Ações, botão CSV.
- [x] ~~Alerta de baixa amostra~~ (sugestão minha, aprovada) — `amostra_pequena` (< 3 pedidos no período).

Ainda fora do escopo, de propósito:

- [x] ~~Tabela `business_insights` com status manual (v83) + feedback loop~~ — status/nota manuais feitos na Fase F; feedback loop (v87) implementado como efeito OBSERVADO (nunca causal, mesmo princípio de Recuperação em `rankeamento.md`), não como atribuição de causa — ver `business-rules.md`/`decisions.md`. `GET /api/bi/margem/acoes-feedback`.
- [x] ~~Cache/persistência da narrativa da IA~~ — cacheada 30min por filtro (v87, `server/src/db/cached.js`), ver `redis.md`.
- [ ] Indicador de confiabilidade dos dados (% de vendas do período com frete/tarifa já confirmados pela reconciliação automática — ver `financeReconciliationJob`/`finance_synced` em `workers.md` — vs. % ainda em estimativa via `orders.ml_fee`) — sugerido, não implementado ainda.
- [ ] Busca por texto + ordenação por coluna na tabela de Produtos (`bi-margem-produtos.html`) — hoje só filtra por classificação; portfólio grande (>50 SKUs) fica difícil de navegar.
- [ ] Deep link da ação recomendada pro produto (editar custo em `bi-vendas.html`, histórico de vendas do SKU) — hoje mostra o produto mas não linka.

## FinanceEcom — reestruturação em fases A→F (spec de 12 seções, plano em `decisions.md`)

Plano técnico apresentado e aprovado ("todas em sequência A→F"). Fase A concluída nesta rodada:

- [x] ~~Health Score 0-100 (Saúde do Negócio)~~ — `saude` em `GET /api/bi/margem`, 6 sub-scores, card em `bi-margem.html`. Fórmulas em `business-rules.md`.
- [x] ~~"O que mudou" (8 rankings de maior alta/queda por SKU)~~ — `mudancas`.
- [x] ~~Filtros expandidos na Visão Geral~~ (Hoje/Ontem/14 dias/Mês atual/Mês anterior/personalizado/categoria) — `resolverPeriodo()`, `date_from`/`date_to` no backend.
- [x] ~~Badges de contagem no menu~~ (`js/biMargemTabs.js` já suportava `contadores`, só faltava popular) — `skus_ruptura_iminente`/`acoes.length`, em todas as 6 páginas.

Fase B concluída nesta rodada:

- [x] ~~B — Produtos: tabela ordenável, drill-down, cascata, simulador~~ — `GET /api/bi/margem/produto/:itemId` (série diária dedicada), modal em `bi-margem-produtos.html` (Chart.js, cascata, simulador de % livre client-side, ações do produto reaproveitadas).

Fase C concluída nesta rodada:

- [x] ~~C — Portfólio: matriz scatter, cenário de mix~~ — matriz Chart.js (X=volume, Y=MC%, raio=faturamento) clicável (abre `js/biMargemProdutoModal.js`, extraído da Fase B pra reuso entre Produtos/Portfólio), cenário de mix client-side limitado ao faturamento real de baixa margem. Canibalização automática **decidido não implementar** (ver `decisions.md` — risco de dado inventado).

Pendente (Fases D-F, ver `decisions.md` pro plano completo por fase):
- [x] ~~D — Frete & Tarifa: ranking "MC antes/depois do frete/tarifa" por produto, detecção de anomalia~~ — `bi-margem-frete.html`, 100% client-side sobre o payload já carregado (sem endpoint novo). Anomalia compara com a média do PRÓPRIO grupo (logística/conta), não a geral.
- [x] ~~E — Estoque: capital parado (estoque × custo), valor em risco (venda perdida estimada × MC unitária), priorização ponderada por risco×MC×velocidade~~ — `bi-margem-estoque.html`: KPIs (capital parado/ruptura iminente/valor em risco), tabela "Capital parado", coluna/ordenação por Prioridade. `prioridade_score` usa escala ABSOLUTA (não percentil — percentil era rank-sensível demais com poucos SKUs em ruptura, deixava 1 dia de diferença de estoque atropelar 55pp de diferença de margem; pego por teste, corrigido). Ver `business-rules.md`.
- [x] ~~F — Ações + histórico: matriz impacto×esforço visual, regra de exclusividade mútua entre ações, tabela business_insights com status/histórico~~ — `bi-margem-acoes.html`: KPIs (impacto total com exclusividade mútua/total de ações/pendentes/concluídas), matriz Chart.js Impacto×Esforço (clique abre modal de produto), status manual por ação (Pendente/Em andamento/Concluída/Descartada + nota) persistido em `business_insights` (`migrate-v83.sql`, `GET`/`PATCH /api/bi/margem/acoes-status`). Feedback loop causal (medir resultado real pós-ação) continua fora de escopo, 3ª vez adiado deliberadamente — ver `decisions.md`.

**FinanceEcom Fase 3 (spec de 12 seções, plano A→F) CONCLUÍDA** — todas as 6 fases entregues.

## Vendas por Estágio — integração Rankeamento × BI (spec de 29 seções)

Núcleo implementado nesta rodada: tag de estágio em `bi-vendas.html`, página `bi-rankeamento.html` (visão executiva, 4 blocos, tabela de comparação ordenável, evolução temporal, hoje×ontem×média7d, ranking de hoje, vendas de hoje, anúncios por estágio com "fora do padrão", Recuperação antes×depois, score, insights). Ver `modules.md`/`business-rules.md`/`decisions.md`.

Fora do escopo desta rodada, deliberadamente (spec original tinha 29 seções):

- [ ] **§13 conversão avançada** — hoje já calcula conversão básica (pedidos÷visitas via `item_visits`); falta segmentar por tipo de envio/categoria como o pedido original sugeria.
- [ ] **§17-18 cruzamento avançado** (margem+estoque+frete+tarifa por estágio gerando recomendação diferenciada por combinação) — hoje só tem "fora do padrão" simples (desvio de pedidos vs. média do estágio).
- [ ] **§21 alertas** (Telegram quando um estágio cai/sobe significativamente, estoque crítico em anúncio de alta performance) — precisa de infra de notificação nova, fora do escopo desta rodada.
- [ ] **§25 integração com Ações Recomendadas** — os insights de "Vendas por Estágio" e as `acoes[]` de `/api/bi/margem` (Inteligência de Margem) hoje são motores paralelos; unificar (ex.: "anúncio RANQUEADO com estoque baixo → prioridade de reposição") é acoplamento consciente, não uma extensão trivial.
- [ ] **§23 filtros adicionais** — hoje `GET /api/bi/rankeamento` filtra por `days`/`store_id`; falta produto/SKU/categoria/tipo de envio.
- [ ] **§14 "inteligência de transição"** (associação entre mudança de estágio e variação de vendas, além do caso específico de Recuperação já implementado) — precisaria do histórico de fase que não existe (ver `decisions.md`), então ficaria limitado ao mesmo "só o carimbo de entrada atual" já usado em Recuperação; avaliar se vale a pena estender esse mesmo padrão pras outras transições.

## Rankeamento — fase Recuperação (v80)

- [ ] Alerta no Telegram quando uma intervenção fecha a janela de 7 dias **sem efeito** (hoje o veredito `sem_efeito`/`parcial` só aparece no card). Encaixa no snapshot de 6h, com idempotência por `ranking_notes.id` (mesmo padrão do `esfriou`/`sem_resultado`).
- [ ] Calibrar os thresholds do diagnóstico depois de algumas semanas de uso (10 visitas/dia, 1% de conversão — hoje valores fixos em `routes/ranking.js`, documentados em `business-rules.md`). Avaliar torná-los por anúncio/categoria em vez de globais.
- [x] ~~Corrigir `migrate-v78.sql` (SQL inválido) e `migrate-v77.sql` (não idempotente)~~ — feito na v80; `migrate.js` roda limpo (76 ok, 0 erros) e é idempotente.

## Agente Financeiro

- [ ] `pages/financeiro-despesas.html` (DRE/break-even) e `pages/financeiro-projecao-caixa.html` (fluxo/projeção) ainda calculam tudo no próprio `<script>` — `server/src/financeiroCalc.js` é a mesma fórmula extraída pro backend (consumida hoje só pelo Agente Financeiro), mas as duas páginas não foram refatoradas pra consumi-la (risco de regressão numa tela em produção, fora do escopo da tarefa que criou o módulo — ver `decisions.md`). Quando alguém for mexer numa dessas fórmulas de novo, mudar as DUAS cópias (ou aproveitar pra unificar).
- [ ] Avaliar se o Agente Financeiro precisa de mais relatórios (a v1 saiu com 4: DRE, Fluxo+Projeção, Contas a Pagar, Cruzamento ML×Financeiro — outros candidatos ficaram de fora por ora: Compras & CMV, Comparativo por Empresa, Break-even isolado).
- [ ] Confirmar se as tabelas `ml_accounts`/`ml_items`/`ml_orders` dentro do Supabase Financeiro (achado da auditoria) têm dado real de alguma tentativa antiga de integração ML — se sim, decidir se cabe expor no Agente Financeiro; se estiverem vazias/obsoletas, considerar removê-las do schema documentado em `financeiro-supabase-schema.md`.

## Estágio Catálogo / Buy Box (Rankeamento)

- [ ] Cruzamento financeiro ("estratégia") no card do estágio Catálogo — cruzar `price_to_win` com CMV/tarifa/imposto/frete real do produto (`vendaMargem.js`) pra recomendar (ou não recomendar) reduzir o preço pra vencer, conforme a margem que sobraria. Pedido pelo usuário, mas não selecionado nesta rodada — ver `decisions.md`.
- [ ] Confirmar se o tópico de webhook `catalog_item_competition_status` está habilitado no painel de desenvolvedor do Mercado Livre pra este app — sem isso, `handleCatalogCompetitionStatus`/`ranking.onCatalogCompetitionUpdate` nunca rodam (o job diário `sync-catalog-competition` continua cobrindo tudo, só sem tempo real). Quando confirmar que o webhook chega, validar o formato real do `resource` (a extração hoje é defensiva, não testada ao vivo).
- [ ] Depois de rodar em produção por um tempo, avaliar se `MAX_ADS=30` (que já não conta `fase='catalogo'`) precisa de um teto PRÓPRIO pra catálogo — hoje é ilimitado.

## Manutenção da documentação

- [ ] Ao adicionar qualquer rota nova em `routes/*.js`, atualizar `api.md` e o método correspondente em `js/db.js` na mesma tarefa.
- [ ] Ao adicionar/alterar uma tabela, atualizar `database.md` na mesma tarefa (incluir a migration na lista de `db/migrate.js` — não deixar migrations "órfãs" como os casos do item known-bugs #4).
- [ ] Ao adicionar um handler de tópico webhook ou um sync agendado novo, atualizar `workers.md`.
- [ ] Ao publicar um tópico WebSocket novo (ou mudar o payload de um existente), atualizar `websocket.md`.

## Este arquivo é o ponto de entrada para retomar trabalho

Ao iniciar uma sessão nova, além de ler toda a pasta `.claude` (regra em `CLAUDE.md`), verificar se há itens `[ ]` aqui antes de assumir que não há trabalho pendente conhecido.
