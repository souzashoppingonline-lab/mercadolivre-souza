# TODO

> Lista viva de itens acionáveis e concretos — granularidade de tarefa, não de direção estratégica (`roadmap.md`) nem de defeito documentado sem plano de ação definido (`known-bugs.md`, embora todo item de `known-bugs.md` com "Correção esperada" definida vire candidato natural a entrar aqui). Marque `[x]` ao concluir e mova o resultado relevante para `decisions.md`/`database.md`/etc. conforme o caso. Adicione itens novos sempre que uma tarefa ficar pendente ao final de uma sessão.

## Integração Amazon — bloqueado aguardando resposta do usuário

- [ ] **Confirmar a decisão de schema** antes de escrever qualquer migration: coluna `marketplace` discriminadora em `stores`/`orders`/`items` (recomendado, ver `roadmap.md`) vs. tabelas paralelas (`amazon_orders`, `amazon_items`).
- [ ] Obter `AMAZON_LWA_CLIENT_ID` e `AMAZON_LWA_CLIENT_SECRET` (Login with Amazon) — sem eles `amazonClient.js` não troca o refresh token por access token.
- [ ] Confirmar `AMAZON_MARKETPLACE_ID` (Brasil = `A2Q3Y263D00KWC`) e `AMAZON_REGION` (assumido `na`).
- [ ] Definir se o primeiro corte usa polling periódico (mais simples, recomendado) ou assinatura da Notifications API (SNS/SQS) — ver `amazon.md`.
- [ ] Depois de confirmado: migration da coluna `marketplace`, worker/fila dedicado, rota REST (ou extensão das existentes se for coluna discriminadora), atualizar `database.md`/`workers.md`/`api.md`.

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
