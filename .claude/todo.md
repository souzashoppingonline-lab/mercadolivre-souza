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

## Inteligência de Margem — Fase 2/3 (deliberadamente fora desta tarefa)

O usuário pediu um analista financeiro completo (30 seções de especificação: causa raiz textual, resumo executivo, score, simulação de preço multi-cenário, tabela de histórico com feedback loop). Implementada a **Fase 1 — motor determinístico** (`GET /api/bi/margem`, `pages/bi-margem.html`, ver `modules.md`/`business-rules.md`): tudo que dá pra calcular sem IA, com número real e premissa explícita. Fora do escopo desta tarefa, de propósito (ver `decisions.md`):

- [ ] **Camada de LLM** escrevendo a narrativa em português (causa raiz decomposta — "a margem caiu X p.p., a causa principal foi..."; resumo executivo diário; "o que eu faria agora" em texto corrido) em cima do JSON já calculado pela Fase 1 — nunca deixar o LLM fazer conta financeira, só interpretar o que o backend já calculou (mesma separação backend-determinístico/LLM-narrativo pedida pelo usuário). Reusar `server/src/ai/llm.js` (padrão Haiku barato de `analise-produtos.md`).
- [ ] **Simulação de preço multi-cenário** (+3%/+5%/+10%, não só +5%) — hoje `bi-margem.html` só simula 1 cenário dentro da ação "Reprecificar".
- [ ] **Tabela `business_insights`** (histórico de insights com status novo/em_analise/executado/ignorado/resolvido) + feedback loop (impacto estimado vs. realizado) — precisa de UI de acompanhamento, não é só a tela de análise atual.
- [ ] Decomposição de causa raiz por variação de período (§19 do pedido original: "a margem caiu 3,4 p.p., 62% disso veio do aumento do peso de SKUs com MC<15%") — hoje a Fase 1 mostra o "antes/depois" agregado mas não decompõe QUANTO de cada causa (mix de produto vs. custo vs. frete vs. tarifa) contribuiu pra variação.

## Rankeamento — fase Recuperação (v80)

- [ ] Alerta no Telegram quando uma intervenção fecha a janela de 7 dias **sem efeito** (hoje o veredito `sem_efeito`/`parcial` só aparece no card). Encaixa no snapshot de 6h, com idempotência por `ranking_notes.id` (mesmo padrão do `esfriou`/`sem_resultado`).
- [ ] Calibrar os thresholds do diagnóstico depois de algumas semanas de uso (10 visitas/dia, 1% de conversão — hoje valores fixos em `routes/ranking.js`, documentados em `business-rules.md`). Avaliar torná-los por anúncio/categoria em vez de globais.
- [x] ~~Corrigir `migrate-v78.sql` (SQL inválido) e `migrate-v77.sql` (não idempotente)~~ — feito na v80; `migrate.js` roda limpo (76 ok, 0 erros) e é idempotente.

## Manutenção da documentação

- [ ] Ao adicionar qualquer rota nova em `routes/*.js`, atualizar `api.md` e o método correspondente em `js/db.js` na mesma tarefa.
- [ ] Ao adicionar/alterar uma tabela, atualizar `database.md` na mesma tarefa (incluir a migration na lista de `db/migrate.js` — não deixar migrations "órfãs" como os casos do item known-bugs #4).
- [ ] Ao adicionar um handler de tópico webhook ou um sync agendado novo, atualizar `workers.md`.
- [ ] Ao publicar um tópico WebSocket novo (ou mudar o payload de um existente), atualizar `websocket.md`.

## Este arquivo é o ponto de entrada para retomar trabalho

Ao iniciar uma sessão nova, além de ler toda a pasta `.claude` (regra em `CLAUDE.md`), verificar se há itens `[ ]` aqui antes de assumir que não há trabalho pendente conhecido.
