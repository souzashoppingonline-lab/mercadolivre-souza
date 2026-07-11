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
- [ ] Confirmar em produção que o pedido de teste do `TEST_CASE_200` chega até `orders`/`amazon_order_data` de ponta a ponta (a correção do `getOrder` foi deployada junto com o mock — ainda não testada isoladamente com `AMAZON_ENV=sandbox`).
- [x] Testado `AMAZON_ENV=mock` em produção — pedido fabricado (`MOCK-924-4509518-5060956`) passou pela fila e foi gravado em `orders`/`amazon_order_data` corretamente.
- [ ] Validar se `mapAmazonStatus()` (`marketplaceEventWorker.js`) está mapeando `OrderStatus` da Amazon para `orders.status` de forma sensata — só dá pra confirmar de fato quando pedidos (mesmo que de sandbox) começarem a chegar.
- [ ] Expor Amazon nos endpoints de leitura (`routes/api.js`) filtrando/agrupando por `marketplace_id` — hoje as queries existentes não incluem pedidos Amazon nas telas do dashboard.
- [ ] Rota REST dedicada só é necessária se algo não couber nos endpoints existentes com `marketplace_id`.
- [ ] Notificação Telegram de vendas Amazon (fora de escopo da v15).
- [ ] Trocar `AMAZON_ENV` para `production` só depois de autorização de produção aprovada pela Amazon no Seller Central.

## Débito técnico — Marketplace Engine (v15)

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
