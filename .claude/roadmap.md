# Roadmap

> Escopo: direção futura do produto/arquitetura — o que está planejado, não o que está quebrado agora (`known-bugs.md`) nem uma lista de tarefas granulares acionáveis (`todo.md`). **Ao concluir um item aqui, mova o resultado para `decisions.md` (se envolveu escolha de design) e remova daqui.**

## Multi-marketplace: Shopee e Amazon

Amazon **ligada ao banco/worker desde v15** (tabela `marketplaces` + `marketplace_id` discriminador, `AmazonPollingEventSource` → `marketplaceEventWorker.js`, rodando em sandbox). Status por marketplace: `mercadolivre.md` (único em produção real), `amazon.md` (conectada, sandbox), `shopee.md` (bloqueada — app em aprovação, só stub).

### Fase 2 — normalização completa via Strangler Pattern (não iniciada)

A v15 deliberadamente **não** normalizou o schema: `orders`/`items` continuam "achatados" (item+frete embutidos em `orders`, sem tabelas `order_items`/`products`/`inventory`/`shipments`/`customers` separadas) para não arriscar o pipeline ML em produção. Quando fizer sentido (Amazon estável, Shopee integrada), a normalização completa deve ser feita em fases pelo padrão **Strangler Pattern**: extrair um módulo por vez (ex: primeiro `shipments` para fora de `orders`, depois `order_items`, depois `customers`) mantendo compatibilidade com o schema antigo até cada extração ser validada em produção — nunca uma migração "big bang" que troca tudo de uma vez. Ver `decisions.md` ("Marketplace Engine — schema evolutivo").

### `EventSource`/`Scheduler` — migração futura do ML/Shopee (avaliação, não decidida)

O padrão `EventSource` (`start/stop/discoverEvents`) + `Scheduler` foi implementado para a Amazon (`AmazonPollingEventSource`). Migrar o Mercado Livre (hoje webhook direto, `Gateway → BullMQ → worker.js`) para uma `MercadoLivreEventSource` sob esse mesmo padrão é uma possibilidade futura, não uma decisão tomada — só faz sentido avaliar depois que Amazon (e Shopee, quando integrada) provarem o padrão estável em produção. Ver `decisions.md`.

## Descomissionamento do sistema antigo (`ml-dashboard.service`)

Ver checklist completo em `deployment.md` → "Transição do sistema antigo". Resumo do critério de conclusão:
1. Webhook do ML apontando só para `/webhooks/ml` deste backend.
2. `webhook_logs.status='processed'` estável, sem acúmulo de `failed`.
3. Dashboard novo confirmadamente exibindo dados reais do Postgres em todas as telas relevantes.

Status: não confirmado neste documento — verificar no ambiente de produção antes de desligar o serviço legado.

## Publicidade (Ads) — endpoint ainda exploratório

`GET /api/publicidade` (ver `api.md`) hoje testa múltiplos endpoints de advertising da API do ML por loja até um responder OK, sem contrato de dados estável — é usado como diagnóstico (`server/test-ads.js` é um script de exploração manual do mesmo problema). Falta decidir o endpoint definitivo da API de Advertising do ML a adotar e desenhar uma tabela própria (`ad_campaigns`, `ad_metrics`) em vez de repassar a resposta crua do ML para o frontend.

## Cobertura de índice único para `messages.pack_id`

Ver `known-bugs.md` item 4 — `migrate-v10.sql` (índice único `messages_pack_id_unique`) não está na lista aplicada por `db/migrate.js`. Antes de qualquer trabalho novo em `messages`/mensagens, isso precisa ser corrigido (é pré-requisito, não trabalho novo em si).

## Agenda Trello — regras automáticas futuras

Fase 1 (v19) implementou só 2 regras automáticas (estoque crítico, score baixo), escopo Mercado Livre. O `TaskEngine` foi desenhado para crescer sem refatoração — ver a lista completa de regras cogitadas (pedidos atrasados, ROI negativo, produto sem venda há 30 dias, Buy Box Amazon, etc.) em `task-engine.md` ("Extensibilidade — regras futuras"), nenhuma implementada ainda. Quando Amazon/Shopee amadurecerem o suficiente para gerar eventos próprios de negócio, o mesmo `TaskEngine` deve suportá-los sem trocar de arquitetura — mesma decisão de "uma camada comum, adapters por marketplace" já usada no restante do sistema (ver `decisions.md`, "Marketplace Engine").

## KPIs por loja com cache dedicado

`redis.md`/`known-bugs.md` apontam que a chave `kpis:{storeId}` é invalidada pelo worker mas nunca lida por nenhuma rota — sugere uma feature de "resumo de KPIs por loja individual" que foi cogitada e não implementada. Se houver demanda por essa tela, o cache já está parcialmente preparado do lado da invalidação.
