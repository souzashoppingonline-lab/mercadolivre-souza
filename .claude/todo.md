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
- [x] **Alternador de marketplace (`.mkt-switcher-compact`) no topbar de toda página** — Mercado Livre/Amazon/Shopee, sempre no canto superior direito, para trocar de marketplace de qualquer tela sem passar pela sidebar. Injetado por `js/layout.js` em toda página ML e hardcoded em `index.html`; cada dashboard dedicado (`dashboard-amazon.html`/`dashboard-shopee.html`) tem sua própria cópia no topbar independente. Ver `frontend.md`.
- [ ] `dashboard-ml.html` dedicado (hoje o botão "Mercado Livre" do switcher aponta para `../index.html`, o dashboard ML existente) — só criar se/quando fizer sentido separar do `index.html` atual.
- [ ] Dashboard unificado "visão geral" (`dashboard.html`, todos os marketplaces juntos: Receita Total, Pedidos Totais, Produtos Totais, Anúncios Ativos) — explicitamente deixado para depois pelo usuário.
- [ ] Hot-reload de contas Amazon no worker — hoje uma conta cadastrada via `POST /api/lojas/amazon` só é sincronizada depois de reiniciar `ml-worker-novo` manualmente.
- [ ] Validar se `mapAmazonStatus()` (`marketplaceEventWorker.js`) está mapeando `OrderStatus` da Amazon para `orders.status` de forma sensata — só dá pra confirmar de fato quando pedidos reais começarem a chegar.
- [ ] Dashboard multi-marketplace de verdade (ML+Amazon juntos) — hoje as telas continuam ML-only por padrão (views `ml_*`); unificar é decisão de produto/UX futura, não bloqueia o uso atual.
- [ ] Notificação Telegram de vendas Amazon (fora de escopo até agora).
- [ ] Trocar `AMAZON_ENV` para `production` só depois de autorização de produção aprovada pela Amazon no Seller Central.

## Débito técnico — Marketplace Engine (v15/v16)

- [ ] Fase 2: normalização completa (`order_items`/`products`/`inventory`/`shipments`/`customers`) via Strangler Pattern, módulo a módulo — ver `roadmap.md`.
- [ ] Renomear `orders.ml_id` para algo marketplace-neutro (ex: `external_order_id`) — mantido por ora para não tocar em todo `api.js`/`worker.js`/frontend que já referenciam esse nome.
- [ ] Avaliar migrar `MercadoLivreEventSource`/`ShopeeEventSource` para o padrão `EventSource`/`Scheduler` — só depois que Amazon (e Shopee) provarem o padrão estável em produção (ver `decisions.md`).

## Integração Shopee — bloqueado no app

- [ ] Aguardando aprovação do app pela Shopee (`Partner ID`/`Partner Key`). Sem isso, `shopeeClient.js` permanece stub — não iniciar implementação real antes disso (ver `shopee.md`).

## Débito técnico registrado nesta tarefa

- [ ] Avaliar migrar `mlClient.js`/`routes/auth.js` para `server/src/marketplaces/mercadolivre/` seguindo o padrão `MarketplaceClient` — só depois que a Amazon estiver de fato funcionando em produção com esse padrão (ver `decisions.md`, "Marketplace Engine").

## Correções pendentes (originadas de `known-bugs.md`)

- [ ] Criar migration adicionando `questions.tg_message_id BIGINT` e incluí-la em `db/migrate.js` (item 1 de `known-bugs.md`) — sem isso, responder perguntas via reply no Telegram não persiste o vínculo.
- [ ] Incluir `migrate-v10.sql` (índice único `messages_pack_id_unique`) na lista de `db/migrate.js`, ou migrar seu conteúdo para `schema.sql` (item 4 de `known-bugs.md`).
- [ ] Decidir e documentar em `decisions.md`: remover o tópico WS `kpis_updated` (código morto) ou implementar sua publicação de fato (item 2 de `known-bugs.md`).
- [ ] Avaliar se `PATCH /api/custos/:sku` deveria exigir/validar que o `sku` informado é de fato um `ml_id` válido, ou desacoplar de vez `sku_costs` de `items.cost` (item 3 de `known-bugs.md`).

## Manutenção da documentação

- [ ] Ao adicionar qualquer rota nova em `routes/*.js`, atualizar `api.md` e o método correspondente em `js/db.js` na mesma tarefa.
- [ ] Ao adicionar/alterar uma tabela, atualizar `database.md` na mesma tarefa (incluir a migration na lista de `db/migrate.js` — não deixar migrations "órfãs" como os casos do item known-bugs #4).
- [ ] Ao adicionar um handler de tópico webhook ou um sync agendado novo, atualizar `workers.md`.
- [ ] Ao publicar um tópico WebSocket novo (ou mudar o payload de um existente), atualizar `websocket.md`.

## Este arquivo é o ponto de entrada para retomar trabalho

Ao iniciar uma sessão nova, além de ler toda a pasta `.claude` (regra em `CLAUDE.md`), verificar se há itens `[ ]` aqui antes de assumir que não há trabalho pendente conhecido.
