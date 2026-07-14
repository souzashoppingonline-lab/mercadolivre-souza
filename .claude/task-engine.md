# Agenda Trello — TaskEngine

> Escopo: o módulo "Agenda Trello" (quadro Kanban de tarefas do Analista de E-commerce) e o `TaskEngine` que centraliza toda geração automática de cartões. Schema de `tasks`/`task_comments` está em `database.md` (não repetido aqui). Rotas REST em `api.md`. Página em `frontend.md`. Eventos WS em `websocket.md`.

## Por que um módulo separado, não reaproveitando `reposicao`/`anuncios-problema`

O pedido original era um quadro de tarefas genérico do "Analista de E-commerce" — não uma tela nova de estoque/qualidade (essas já existem: `reposicao.html`, `anuncios-problema.html`). A Agenda Trello não substitui essas páginas; ela **consome os mesmos sinais** (estoque crítico, score baixo) e os transforma em itens de trabalho rastreáveis (coluna, prioridade, responsável, comentários), com histórico de progresso que uma tela de alerta pura não tem. Por isso: tabela própria (`tasks`), sem FK para `orders`/`items` (só uma referência solta em `item_id`, texto — a tarefa deve sobreviver mesmo se o anúncio for removido/alterado depois), e sem tocar em nenhuma rota/tabela existente.

## `server/src/taskEngine.js` — toda regra de negócio vive aqui

Módulo puro (só Postgres, sem BullMQ/Telegram/WS) — mesmo espírito de `reports.js` (consultas compartilhadas): centraliza a lógica para que nenhuma página ou handler de worker monte um `INSERT INTO tasks` diretamente.

```js
createTaskIfNotExists({ ruleKey, itemId, title, description, priority, storeId, source, metadata })
checkStock({ itemId, title, availableQuantity, permalink, storeId, storeName })
checkQuality({ itemId, title, score, problems, permalink, storeId, storeName })
```

- **`createTaskIfNotExists`** é o único ponto que escreve em `tasks`. Resolve `marketplace_id` (hoje sempre `'ML'`, cacheado em memória após a 1ª consulta) e faz o dedup: `SELECT ... WHERE rule_key=$1 AND item_id=$2 AND board_column NOT IN ('finalizado','excluido')`. Se já existe um cartão aberto para aquela regra+item, só atualiza `updated_at`/`metadata` (mesma tarefa continua "viva"); senão insere um novo em `board_column='a_fazer'`. Índice parcial dedicado em `tasks` (ver `database.md`) torna essa checagem barata mesmo com a tabela grande.
- **Regra 1 — `checkStock`** (`rule_key='estoque_critico'`): dispara quando `available_quantity <= 5` — **mesmo limiar** já usado no alerta Telegram `tg_reposicao` (não um novo threshold configurável; a Agenda Trello reflete o mesmo sinal que já existe, não inventa um segundo). Cartão: título `"Repor estoque urgente: <título do anúncio>"` (o título do item entra no título do cartão para diferenciar cartões desta regra na coluna sem precisar abrir cada um), prioridade `alta`, `metadata` com SKU/título/quantidade/loja/marketplace/link.
- **Regra 2 — `checkQuality`** (`rule_key='score_baixo'`): dispara quando `score < 50` (score de qualidade do anúncio, `/item/:id/performance` do ML). Cartão: título `"Melhorar qualidade: <título do anúncio>"` (mesmo racional da regra 1), prioridade `media`, `metadata` com score atual, lista de problemas (`buckets[].variables` com `status='PENDING'`), loja/marketplace/link.
- **Título do item no título do cartão, não recalculado na atualização**: quando um cartão automático já aberto é só "tocado" de novo pela mesma regra (dedup — ver abaixo), o `title` gravado na criação **não** é atualizado, só `metadata`/`updated_at`. Se o anúncio for renomeado depois, o título do cartão fica com o nome antigo até o cartão ser fechado e um novo ser criado — comportamento aceito, consistente com "não recriar, só atualizar a data" pedido na especificação original.
- Ambas as funções engolem qualquer erro internamente (`try/catch` + `console.warn`) — uma falha do TaskEngine (ex.: tabela `tasks` indisponível) **nunca** deve derrubar `handleItem`/`syncScores`, que têm responsabilidades muito mais críticas (persistir o anúncio/score em si).

## Onde é chamado (`server/src/worker.js`)

- **`handleItem`** (handler do tópico webhook `items`): logo após o alerta de estoque existente (`if (item.available_quantity <= 5) { ... stock_alert ...}`), chama `taskEngine.checkStock(...)`. Roda a cada webhook de item — é o mesmo gatilho de tempo real que já existe para o alerta Telegram.
- **`syncScores`** (job diário 01:00, ver `workers.md`): depois de gravar `item_performance`, chama `taskEngine.checkQuality(...)` para cada item com `score` calculado. Só roda uma vez por dia (ritmo do próprio job de score), não em tempo real.
- Quando `createTaskIfNotExists` efetivamente **cria** um cartão novo (não quando só atualiza um existente), `worker.js` publica `task_created` no WS (`{ id, rule_key, title }`) — consumido por `pages/agenda-trello.html` para mostrar um toast e recarregar o quadro. Essa é a "notificação interna" pedida na especificação; integração com Telegram fica para o futuro (não implementada).

## Escopo atual — só Mercado Livre

Por pedido explícito, as duas regras automáticas hoje **só avaliam itens/lojas do Mercado Livre** (`checkStock`/`checkQuality` são chamadas só a partir de handlers ML em `worker.js`; `source` default é `'mercado_livre'`, `marketplace_id` resolvido sempre para `code='ML'`). A coluna `source` já aceita `amazon`/`shopee`/`sistema`/`manual` como valores válidos (schema pronto para o futuro), mas nenhuma regra automática os produz ainda — só a criação manual de tarefa (`POST /api/tasks`, `source='manual'`) pode gravar qualquer marketplace.

## Extensibilidade — regras futuras (não implementadas)

O padrão `checkX({ ... }) → createTaskIfNotExists({ ruleKey: 'x', ... })` foi desenhado para que uma regra nova seja só mais uma função em `taskEngine.js` + uma chamada no ponto certo de `worker.js`, sem tocar nas existentes. Regras cogitadas, citadas pelo usuário, **nenhuma implementada agora**:

- Pedidos atrasados (SLA de envio estourado)
- Perguntas sem resposta há X horas
- Mensagens pós-venda sem resposta
- ROI negativo (cruzar com `ml_turbo_sales`/`finance.md`)
- Produto sem venda há 30 dias (já existe o dado em `GET /api/analises/estoque-parado?modo=parado` — reaproveitar, não recalcular)
- Produto líder perdendo posição (concorrência)
- Preço abaixo da margem mínima
- Campanha ADS com performance ruim
- Produto sem Buy Box (Amazon)
- Problemas Shopee/Amazon (quando essas integrações amadurecerem)
- Boletos vencendo, fluxo de caixa, contas a pagar (módulo financeiro, fora do escopo de e-commerce operacional)

Ao implementar qualquer uma, seguir o mesmo contrato (`rule_key` único, dedup por `rule_key+item_id`, engolir erro internamente) e atualizar esta seção.

## Checklist (futuro, não implementado)

O campo "Checklist" por cartão, mencionado na especificação original, foi deliberadamente deixado de fora desta fase (marcado como "(futuro)" no próprio pedido) — `tasks.metadata` (JSONB) já teria espaço para guardar uma estrutura de checklist sem precisar de migration nova quando for implementado.
