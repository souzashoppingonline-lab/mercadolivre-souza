# TODO

> Lista viva de itens acionáveis e concretos — granularidade de tarefa, não de direção estratégica (`roadmap.md`) nem de defeito documentado sem plano de ação definido (`known-bugs.md`, embora todo item de `known-bugs.md` com "Correção esperada" definida vire candidato natural a entrar aqui). Marque `[x]` ao concluir e mova o resultado relevante para `decisions.md`/`database.md`/etc. conforme o caso. Adicione itens novos sempre que uma tarefa ficar pendente ao final de uma sessão.

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
