# Decisões Arquiteturais (ADR resumido)

> Escopo: registro histórico de "por que fizemos assim e não de outro jeito". Não repita a mecânica atual (isso já está em `workers.md`/`mercadolivre.md`/etc.) — aqui só o racional e o antes/depois quando existir. **Toda decisão arquitetural nova (escolha entre duas abordagens, correção de um bug de design, trade-off aceito conscientemente) deve ser registrada aqui na mesma tarefa em que for tomada.**

## Webhook → BullMQ → Worker (EDA), nunca chamada direta do frontend à API do ML

**Decisão**: todo dado exibido no dashboard vem do Postgres, populado por webhooks processados de forma assíncrona. **Por quê**: a API do ML tem rate limit por app; se cada carregamento de página disparasse chamadas diretas, o limite estouraria rapidamente com múltiplos usuários/abas abertas. Webhooks + fila absorvem picos e permitem retry/backoff sem impactar a experiência do usuário. Ver `architecture.md`.

## Filas BullMQ separadas por loja (`ml-webhooks-{storeId}`)

**Decisão**: um worker + fila por `store_id`, com `concurrency: 3` e `limiter: 3 req/3s`. **Por quê**: cada loja tem app ML próprio, logo rate limit independente na API do ML. Uma fila global compartilhada faria uma loja com muito tráfego (ou em rate limit) atrasar o processamento de todas as outras. Ver `workers.md`.

## `jobId` estável (`topic:resource:storeId`) no enfileiramento

**Decisão**: usar um `jobId` determinístico em vez de deixar o BullMQ gerar um ID aleatório por job. **Por quê**: o ML pode reenviar o mesmo webhook antes do primeiro job terminar (retry do lado do ML); sem `jobId` estável, isso criaria jobs duplicados processando o mesmo recurso simultaneamente. Ver `workers.md`.

## Cooldown de OAuth 429: 35 min → 5 min

**Decisão histórica**: o cooldown após um 429 no refresh de token era 35 minutos; foi reduzido para 5 minutos. **Por quê**: 35 min era agressivo demais e bloqueava o processamento de webhooks válidos da loja inteira por muito tempo a cada rate limit pontual — 5 min já é suficiente para o ML resetar a janela de rate limit do OAuth, e reduz o tempo em que a loja fica "surda" a eventos reais. Ver `mercadolivre.md`.

## Bug corrigido: loop infinito de retry no 429 do OAuth

**Histórico**: `auth.js` tinha recursão automática ao receber 429 no refresh de token, o que podia gerar um loop de chamadas ao endpoint de OAuth do ML (piorando o próprio rate limit que causou o erro). **Correção aplicada**: `refreshToken` agora lança `OAUTH_RATE_LIMITED` imediatamente no 429, sem retry interno — quem decide o que fazer com o erro é o chamador (`mlClient.getAccessToken`, que aplica o cooldown; ou o worker, que loga e segue). Ver `mercadolivre.md`.

## Compare-and-swap (CAS) no `refreshToken`

**Decisão**: antes de gravar sucesso ou falha de um refresh de token, comparar se `stores.refresh_token` ainda é o mesmo valor lido no início da função (`WHERE refresh_token = $oldRefreshToken`). **Por quê**: existe uma corrida possível entre o refresh automático do worker e uma reconexão manual do usuário (`/auth/login`) acontecendo ao mesmo tempo. Sem CAS, o refresh automático (baseado num token já obsoleto) podia sobrescrever ou invalidar um token novo e válido que acabou de ser salvo pela reconexão manual. Ver `mercadolivre.md`.

## Token "epoch zero" não é mais alvo de refresh automático

**Decisão**: quando um token é invalidado definitivamente (3 falhas consecutivas de refresh), ele é marcado com `token_expires_at = '1970-01-01'`. O `tokenRefreshLoop` detecta esse padrão e **não tenta mais renovar automaticamente** — só notifica via Telegram e exige reconexão manual (`/auth/login?store_id=X`). **Por quê**: tentar refresh num token permanentemente inválido sempre retorna 400 do ML e reescreveria `1970-01-01` de novo, o que destruiria qualquer reconexão manual feita em paralelo pelo usuário (mesma classe de corrida que o CAS resolve, mas nesse caso a solução é simplesmente parar de tentar). Ver `mercadolivre.md`, `workers.md`.

## Vendas ML Turbo (planilha) como fonte financeira oficial, `orders` como fonte operacional

**Decisão**: em vez de tentar reconstruir tarifas/impostos/fretes exatos a partir do payload do webhook `orders_v2` (que nem sempre traz todos os componentes de custo do ML de forma completa), o sistema mantém uma tabela separada (`ml_turbo_sales`) alimentada pela planilha oficial exportada pelo Mercado Turbo, que já vem com esses valores calculados pelo próprio ML. **Trade-off aceito**: a fonte financeira "de verdade" não é tempo real — depende de upload manual periódico. `orders` continua sendo usada para tudo operacional/tempo real, mas não deve ser tratada como fonte de verdade para fechamento financeiro. Ver `finance.md`, `business-rules.md`.

## `account` da planilha Turbo sem FK para `stores`

**Decisão consciente (trade-off)**: o campo `ml_turbo_sales.account` é texto livre, sem relação com `stores.id`. **Por quê**: a planilha do Mercado Turbo identifica a conta por nome/nickname, não por ID interno do ML, e o mapeamento de aliases de coluna (`finance.md`) já lida com naming inconsistente entre exports. **Custo aceito**: join entre `ml_turbo_sales` e `stores` não é possível diretamente; renomear uma loja não retroage sobre vendas já importadas (é preciso reimportar).

## `GET /api/vendas/hoje` como endpoint dedicado (não reaproveita filtro de período)

**Decisão**: existe uma rota específica para "vendas de hoje" em vez de reusar `GET /api/vendas/detalhado?days=1` (que poderia ter drift de fuso horário/cache). **Por quê**: KPIs do dia precisam ser exatos e sempre relativos a `CURRENT_DATE`, independente de qualquer filtro de período selecionado em outra tela — um endpoint dedicado remove ambiguidade. Ver `api.md`.

## Marketplace Engine — camada comum para Mercado Livre/Shopee/Amazon

**Decisão**: em vez de três integrações totalmente independentes, criar `server/src/marketplaces/{interfaces,base,mercadolivre,shopee,amazon}/` — um contrato comum (`interfaces/MarketplaceClient.js`: `refreshAccessToken`, `getOrder`, `listRecentOrders`) e erros compartilhados (`base/errors.js`: `MarketplaceRateLimitError`, `MarketplaceTokenInvalidError`, `MarketplaceTransientError`) que todo adapter novo implementa. **Por quê**: evita reimplementar a mesma forma de lidar com rate limit/token inválido/erro transiente a cada novo marketplace — o Mercado Livre já fez essa descoberta "na marra" (histórico de bugs em `mercadolivre.md`/decisões acima); os adapters novos partem já sabendo disso.

**Trade-off aceito conscientemente**: `mlClient.js`/`routes/auth.js` (Mercado Livre) **não foram migrados** para essa estrutura nem tocados de forma alguma — é a única integração em produção, testada e com histórico de correções (CAS no refresh, cooldown de 429, etc.); migrá-la agora seria risco sem benefício imediato. A migração do ML para `marketplaces/mercadolivre/` fica como tarefa futura explícita (ver `todo.md`), só depois do padrão provar valor com a Amazon.

**Status da Amazon**: desde v15, `AmazonPollingEventSource` + `marketplaceEventWorker.js` ligam de fato `amazonClient.js` ao banco (`orders`/`amazon_order_data`), rodando em sandbox. Ver detalhe completo em `amazon.md` e a decisão de schema abaixo ("Marketplace Engine — schema evolutivo").

**Status da Shopee**: app em aprovação — só existe um stub que documenta o contrato e recusa qualquer chamada real (ver `shopee.md`).

## Marketplace Engine — schema evolutivo (v15) e padrão `EventSource`/`Scheduler`

**Contexto**: era preciso decidir como o schema (hoje 100% modelado em torno do Mercado Livre) acomodaria a Amazon sem virar uma reescrita arriscada de um pipeline em produção processando vendas reais.

**Decisão de schema — coluna discriminadora, sem normalização profunda ainda**: criada a tabela `marketplaces` (catálogo) + coluna `marketplace_id` (FK) em `stores`/`orders`/`items`/`messages`, com backfill de todo dado existente para `code='ML'`. **Não** foram criadas tabelas normalizadas (`order_items`, `products`, `inventory`, `shipments`, `customers`) — `orders`/`items` continuam "achatados" exatamente como sempre estiveram para o ML. Campos exclusivos de um marketplace vão para uma tabela auxiliar própria (`amazon_order_data` hoje) em vez de poluir `orders` com colunas que só fazem sentido para um marketplace. **Trade-off aceito conscientemente**: hoje `orders` ainda mistura "campos comuns" com alguns campos historicamente ML-específicos (`ml_fee`, `shipping_type`, etc.) que não foram extraídos — extrair isso é trabalho de uma fase 2 (normalização completa via **Strangler Pattern**: migração módulo a módulo, sem downtime, só depois que Amazon — e futuramente Shopee — estiverem estáveis). Ver `roadmap.md`.

**Mudança de tipo `orders.ml_id` `BIGINT` → `TEXT`**: necessária porque IDs de pedido de outros marketplaces não são numéricos (ex: Amazon `"902-1845936-3456781"`). Validado antes da migration que `ml_id` é usado em todo o código só como chave opaca de igualdade/join, nunca em `ORDER BY`/aritmética — conversão seguramente não-destrutiva (`returns.order_id` convertido junto, mesma FK). O nome da coluna continua `ml_id` por ora — renomear para algo marketplace-neutro tocaria `worker.js`/`api.js`/frontend inteiros; registrado como débito técnico consciente em `todo.md`.

**Decisão do padrão `EventSource`/`Scheduler`**: para desacoplar "como descobrir um evento novo" (webhook, polling, Notifications API/SNS-SQS) de "o que fazer com o evento", foi criado o contrato `EventSource` (`start/stop/discoverEvents`) e um `Scheduler` genérico que dispara `discoverEvents()` no intervalo registrado por fonte. O Worker que consome os eventos publicados (`marketplaceEventWorker.js`) só reage ao formato padronizado `{marketplace, event, resourceId, sellerId, timestamp}` — nunca sabe se a origem foi polling ou push. **Só `AmazonPollingEventSource` foi implementada de verdade** (é a única com credenciais/caso de uso real hoje); `MercadoLivreEventSource`/`ShopeeEventSource` **não foram criadas** como esqueleto — migrar o ML (hoje webhook, funcionando, testado em produção) para esse padrão é uma avaliação futura explícita, só depois que Amazon e Shopee provarem o padrão estáveis (mesmo racional de "não tocar no que já funciona" já usado acima para não migrar `mlClient.js`/`routes/auth.js`).

**Zero impacto no pipeline ML**: `worker.js` ganhou só 2 linhas aditivas no final do arquivo (`require('./marketplaceEventWorker').startMarketplaceEventWorkers()`); nenhuma linha do dispatch table `handlers`/`processJob` do ML foi alterada. `marketplaceEventWorker.js` roda um `Worker` BullMQ separado, numa fila própria (`marketplace-events-amazon`), sem interferir nas filas `ml-webhooks-*`.

**Efeito colateral encontrado em produção e corrigido na mesma tarefa**: a store sentinela da Amazon vive na mesma tabela `stores` usada pelo OAuth do ML. Quase toda função de `worker.js` que itera lojas (`startWorkers`, `tokenRefreshLoop`, `syncVendas`, `syncMetricas`, `syncParentItems`, `syncReturns`, `syncVisitas`, `syncScores`, comandos `/status`/`/refresh` do bot) faz `SELECT ... FROM stores` sem filtro, assumindo que toda linha é uma loja ML real. Sem exclusão explícita, a sentinela era tratada como loja ML com token "epoch zero", chegando a **disparar alerta falso no Telegram** ("Loja Amazon desconectada... reconecte") a cada 30 min via `tokenRefreshLoop`, além de ganhar uma fila `ml-webhooks-{id}` ociosa em `startWorkers`. **Correção inicial** (exclusão pelo id fixo da sentinela) foi **substituída** pela correção definitiva quando o suporte a múltiplas contas foi implementado (ver "Múltiplas contas por marketplace" abaixo): todas essas queries agora filtram `WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`, cobrindo qualquer quantidade de contas não-ML automaticamente, sem precisar listar IDs.

**Outro efeito colateral encontrado, corrigido na v17**: pedidos de teste (sandbox/mock) gravados em `orders` durante o desenvolvimento contaminaram silenciosamente KPIs agregados do ML (`/dashboard/kpis` soma `orders` de todas as lojas sem filtrar marketplace) — um pedido mock com `date_created` de hoje chegou a somar no card "vendas hoje" real, e a store sentinela da Amazon aparecia na página Lojas com um botão "Reconectar loja" sem sentido. **Ação imediata**: os pedidos de teste foram apagados (`DELETE ... WHERE store_id = 9000000001`). **Correção estrutural (v17)**: em vez de editar manualmente as 30+ queries em `routes/api.js` que liam `orders`/`items`/`stores` sem filtro (alto risco de esquecer alguma ou quebrar sintaxe SQL embutida em template literals), foram criadas views `vw_ml_orders`/`vw_ml_items`/`vw_ml_stores` (`SELECT * FROM <tabela> WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL`), e toda leitura (`FROM`/`JOIN`) em `api.js` foi redirecionada para as views via substituição mecânica verificada (`perl -pe` com word-boundary, confirmado que não tocou nenhum `UPDATE` nem outras tabelas). As telas existentes (`/lojas`, `/dashboard/kpis`, `/vendas/*`, etc.) voltam a mostrar só dados do ML, como sempre mostraram. Quando um dashboard multi-marketplace de verdade for construído, essas rotas específicas trocam de `vw_ml_orders`/`vw_ml_items`/`vw_ml_stores` para as tabelas reais (ou views equivalentes por marketplace) deliberadamente, uma de cada vez.

## Marketplace Engine — cadastro de contas Amazon via UI (v17)

**Decisão**: em vez de continuar exigindo `INSERT` manual em `stores` para cada conta Amazon nova, foram criadas `GET/POST/DELETE /api/lojas/amazon` (ver `api.md`). O `POST` gera um `id` sintético incremental na faixa reservada (`9000000001`, `9000000002`...) e grava `refresh_token`/`amazon_marketplace_id`/`amazon_region` na linha de `stores`. **Trade-off aceito**: não há hot-reload — uma conta nova só é sincronizada depois de reiniciar `ml-worker-novo` manualmente (a resposta da rota avisa isso). Implementar hot-reload (o `Scheduler` registrar uma `EventSource` nova em tempo real, sem restart) fica registrado em `todo.md` como melhoria futura, não bloqueia o uso atual.

## Marketplace Engine — múltiplas contas por marketplace (v16)

**Contexto**: a v15 tratava a Amazon como uma única conta fixa, hardcoded em 4 pontos (`AMAZON_STORE_ID = 9000000001` em `marketplaceEventWorker.js`, `SOURCE_KEY = 'default'` em `AmazonPollingEventSource.js`, cliente único `new AmazonClient(env)`, credenciais só via `.env` global). Isso bloquearia uma segunda conta Amazon ou a primeira conta Shopee sem uma refatoração.

**Decisão**: `stores` já era genérica o bastante para guardar várias contas por marketplace (mesmo padrão do ML — uma linha por conta). Adicionadas só 2 colunas de override por conta (`amazon_marketplace_id`, `amazon_region`) — `refresh_token` reaproveita a coluna genérica que o ML já usa. `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET` continuam globais (identificam o app na Amazon, não o seller — não fazem sentido por conta).

**Mudanças de código**: `amazonClient.js` passou a receber um `cfg` já mesclado (não mais `env` inteiro) — quem monta o merge é `AmazonPollingEventSource`, uma instância por conta. `marketplaceEventWorker.js` busca todas as contas Amazon no boot e registra uma `EventSource`+`client` por conta, com o mapa `clients` chaveado por `stores.id` em vez do código do marketplace. O formato padronizado de evento (`{marketplace, event, resourceId, sellerId, timestamp}`) ganhou o campo **`storeId`** — chave de roteamento para o consumidor saber qual conta/client usar; sem isso, pedidos de contas diferentes ficariam todos atribuídos à mesma `store_id`.

**Trade-off aceito**: ainda não existe rota/UI para cadastrar uma nova conta Amazon — hoje é um `INSERT` manual em `stores` (id sintético seguindo a convenção `9000000001`, `9000000002`...) seguido de restart do worker. Uma rota de administração fica registrada em `todo.md`.

**Bug corrigido em produção logo após o deploy**: o `jobId` passou a incluir `storeId` (`AMAZON:{storeId}:ORDER_UPDATED:{orderId}`, 3 ocorrências de `:`) para manter deduplicação por conta+pedido — mas o BullMQ **exige que um `jobId` customizado, se contiver `:`, tenha exatamente 2** (`split(':').length === 3`); com 3 `:` ele lança `Custom Id cannot contain :`. Corrigido combinando `storeId` e `orderId` com `-` no terceiro segmento (`AMAZON:ORDER_UPDATED:{storeId}-{orderId}`), voltando a 2 `:`. O `jobId` do Gateway do ML (`${topic}:${resource}:${storeId}`) sempre respeitou esse limite por coincidência (2 `:`) — vale lembrar dessa regra do BullMQ em qualquer `jobId` customizado novo.

## `syncVisitas` — lojas sequenciais + circuit breaker (não paralelo)

**Contexto**: `syncVisitas` (02:00 diário) rodava as lojas em paralelo (`Promise.allSettled`), cada uma chamando `/items/{id}/visits/time_window` item a item. Em produção (11/07/2026), isso causou falha quase total: as 3 lojas disparavam a primeira chamada quase no mesmo instante, tomavam 429 juntas, pausavam o mesmo tempo fixo (60s) e voltavam a tentar exatamente no mesmo instante de novo — 15+ minutos seguidos sem uma única chamada bem-sucedida em nenhuma das 3 lojas. Sintoma visível: coluna "Visitas" vazia (`—`) para a maioria dos anúncios no modal de histórico de `performance.html`, e "50/67", "22/28", "57/97 erros" no card de status do sync (ver `.claude/todo.md`/investigação desta tarefa).

**Decisão**: aplicar o mesmo padrão que `syncScores` já usa pro mesmo tipo de 429 do ML — lojas processadas **sequencialmente** (`for...of`, não `Promise.allSettled`), backoff que escala (60s na 1ª tentativa consecutiva, 120s da 2ª em diante) e **circuit breaker**: depois de 5 429 seguidos, aborta o restante dos itens daquela loja no dia (loga e segue pra próxima loja) em vez de esgotar as até 300 tentativas fadadas ao fracasso.

**Por quê não paralelo**: rodar em paralelo era mais rápido no caso feliz, mas sem nenhuma proteção contra as lojas ficarem sincronizadas nas retentativas — uma vez que isso acontece, o job trava indefinidamente sem progresso em nenhuma loja. Sequencial é mais lento no total, mas cada loja tem uma chance real de sucesso independente das outras, e o circuit breaker evita desperdiçar o restante da janela de sync numa loja que já está claramente bloqueada.

**Limite real da API de visitas do ML**: não documentado publicamente com um número exato (o limite geral de 1500 req/min por vendedor não é o gargalo aqui — o volume gerado é muito menor que isso); o comportamento observado em produção indica um limite bem mais restrito e específico desse endpoint. Não vale investir mais tempo tentando descobrir o número exato — a defesa por circuit breaker + backoff escalonado funciona independente do valor real do limite.

**Validado em produção (11/07/2026, sync manual via `/sync visitas` no Telegram)**: RICOPI_MULTIMERCADO 72 itens/4 erros (5,6%), TOP_MIX_ 29 itens/3 erros (10,3%), UNIFULL_MULTIMERCADO 99 itens/3 erros (3,0%) — total 200 itens/10 erros (5%), contra ~68% de erro médio no dia anterior (mesmo código antigo). Nenhuma loja acionou o circuit breaker; a troca pra sequencial já eliminou a maior parte do problema sozinha. Rodada completa das 3 lojas em ~1h20.

## `syncVendas` — alinhado ao ritmo do `syncVisitas` (20s/item, backoff escalonado)

**Contexto**: um commit concorrente (`b083fea`, fora desta sessão) já havia trazido `syncVendas` para o mesmo padrão estrutural do `syncVisitas`/`syncScores` — lojas sequenciais + circuit breaker de 5 429 consecutivos. Mas na execução real de 12/07/2026 (03:00), as 3 lojas ainda estouraram o circuit breaker (`erro: 'rate_limit_abort'` no relatório) — 34 pedidos importados no total, bem abaixo do esperado.

**Causa**: o ritmo entre chamadas ficou em 1,5s por pedido (contra 20s no `syncVisitas`) e o backoff após 429 era fixo em 60s, sem escalar — 13x mais agressivo que a versão que já provou funcionar bem (5% de erro). Também havia um bug de contagem: `consecutive429` era resetado após um `searchOrders` bem-sucedido, mas **não** após um `handleOrder` bem-sucedido dentro do loop de pedidos — então 429s espalhados (não necessariamente consecutivos de verdade) podiam somar até 5 e abortar a loja prematuramente.

**Decisão**: alinhar os 3 parâmetros ao que já foi validado no `syncVisitas` — pausa de 20s entre pedidos processados (era 1,5s), backoff escalonado 60s→120s (era fixo 60s) e reset de `consecutive429` também no sucesso de `handleOrder`. Mesma lógica, mesmo trade-off: mais lento no total, mas com taxa de sucesso muito maior — decisão do usuário, que já tinha visto o resultado do `syncVisitas` e pediu explicitamente para replicar.

## Relatórios por e-mail — Resend, credencial só em `.env`, toggle em `app_config`

**Decisão**: usar a API do Resend (`server/src/resendClient.js`) para enviar 3 relatórios (resumo diário, top vendas do dia, semanal) — free tier (3.000 e-mails/mês, 100/dia) cobre bem o volume de um dashboard single-tenant. Credencial (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`RESEND_TO_EMAIL`) fica só no `.env` do servidor, seguindo o mesmo padrão já estabelecido pelo `notionClient.js` — **não** o padrão do Telegram (`app_config` com fallback pro `.env`, editável por formulário na UI). Só os **3 toggles liga/desliga** de cada relatório (`email_resumo`/`email_topvendas`/`email_semanal`) ficam em `app_config`, editáveis pelo Monitor.

**Por quê essa assimetria com o Telegram**: o Telegram permite trocar de bot/chat pela UI porque múltiplas contas fazem sentido ali (histórico do projeto já tinha esse caso de uso). Para e-mail, o usuário confirmou que só precisa de **um destinatário fixo** — não há necessidade de reconstruir toda a UI de credencial mascarada (`****`+últimos 4 dígitos, endpoint de teste, etc.) só para um único endereço. Se um dia for necessário múltiplos destinatários ou trocar de provedor pela UI, migrar para o padrão do Telegram é a referência a seguir.

**`RESEND_FROM_EMAIL` usa o domínio de teste do Resend por padrão** (`onboarding@resend.dev`) — funciona sem verificação de domínio, ideal para começar rápido. Verificar um domínio próprio no Resend (DNS) é melhoria futura opcional, não bloqueia o uso atual.

**Reaproveitamento de fórmulas existentes, não reinventadas**: o relatório semanal usa a mesma fórmula de margem de `GET /api/vendas/detalhado` (`finance.md`) e a mesma lógica de curva ABC de `GET /api/comparativos/curva-abc` — replicadas via query direta no worker (arquitetura não permite o worker chamar a própria API HTTP do server, só o Postgres diretamente), não uma fórmula nova inventada para o e-mail.

## Análise de Vendas do Mês — sem normalização por dia útil (decisão explícita)

**Contexto**: o pedido original da página especificava normalização por dia útil como "muito importante" (comparar receita ÷ dias úteis decorridos entre meses, já que meses com mais fins de semana têm menos potencial de venda estruturalmente). Perguntado sobre a convenção (segunda-sábado vs. segunda-sexta vs. sem normalização), **o usuário optou explicitamente por não normalizar** — todo dia do mês conta igual em todas as comparações (KPI de crescimento, Gráfico 1, projeção de fechamento).

**Decisão**: implementado sem qualquer ajuste por dia útil. Se o usuário mudar de ideia no futuro, o ponto de entrada é `getResumoDiarioData`-style — nenhuma normalização está pré-computada em nenhuma query, então adicionar depois é aditivo (não requer desfazer nada), mas exige decidir a convenção de dia útil que ficou em aberto (segunda-sábado foi a sugestão original não confirmada).

**Toda a matemática dos insights (regressão, aceleração, projeção, banda estatística) é feita em JavaScript no backend**, depois de só 2 queries agregadas por dia — não em SQL puro. Trade-off consciente: SQL simples e fácil de auditar, mas o payload da rota carrega junto com os dados brutos os campos já calculados (não é uma API "burra" que só devolve linhas cruas) — o frontend não reimplementa nenhuma fórmula, só renderiza o que o backend já calculou. Ver `.claude/business-rules.md` para as fórmulas exatas.

## Dia Ideal + Calendário de Sazonalidade — Caminho A (vanilla JS), não React/TS

**Contexto**: o pedido do usuário para essas duas features veio especificando uma stack completa (React + TypeScript Strict Mode + Tailwind + shadcn/ui + Recharts + Framer Motion + TanStack Query, componentes `.tsx` em `/lib/analytics`) que não existe em nenhuma outra parte deste projeto (`frontend.md`: HTML puro + CSS + JS vanilla, sem bundler/framework).

**Decisão**: antes de escrever qualquer código, o mismatch foi sinalizado ao usuário e perguntado explicitamente qual caminho seguir — Caminho A (JS vanilla, mesma stack do projeto, reaproveitando o padrão já usado em `analise-vendas-mes.html`) ou Caminho B (introduzir de fato um pipeline React/TS novo). **O usuário escolheu o Caminho A**. Implementado com Chart.js (já em uso), CSS puro (grid/flex, sem Tailwind) e funções JS soltas no `<script>` da página (sem separação `/lib/analytics`, já que não há bundler para módulos ES) — mesmo padrão de `renderDiaIdeal`/`renderSeason`/etc. dos demais gráficos da página.

**Por quê**: introduzir um segundo stack de frontend só para 2 componentes quebraria a premissa "HTML puro, sem build step" do projeto inteiro, exigiria decidir bundler/roteamento/deploy do zero, e nenhuma outra página se beneficiaria — custo alto para um ganho que o vanilla JS já entrega (SVG desenhado à mão para o gauge, `Chart.js` para o gráfico de evolução do drawer, grid CSS para o calendário).

## Dia Ideal — sem normalização por dia útil (reconfirmado) e sem Conversão/ROAS na Sazonalidade

**Decisões tomadas sem nova pergunta ao usuário, sinalizadas de forma transparente antes de implementar** (mesma classe de decisão já registrada acima para a página como um todo):

- **Dia Ideal reutiliza a decisão de "sem normalização por dia útil"** já tomada para o resto da página (ver seção acima) — a receita esperada do dia é a média histórica bruta do mesmo dia-do-mês, não ajustada por dia útil/dia da semana equivalente (apesar do pedido original mencionar essas duas normalizações como opção).
- **Calendário de Sazonalidade não inclui Conversão nem ROAS por dia**, apesar de pedidos: Conversão exigiria profundidade histórica de `item_visits` (o sync de visitas só ficou confiável nesta mesma sessão, sem 12 meses de dado consistente ainda); ROAS exigiria gasto de anúncio rastreado por dia, que o sistema não tem. Preferência explícita: não mostrar um número que pareça preciso mas seja calculado sobre dado insuficiente/ausente.
- **Sem filtro de marketplace/categoria** na página — ela é ML-only por design (Amazon já tem páginas isoladas, ver `amazon.md`), e não existe campo "categoria" sincronizado em `items` hoje. Os únicos filtros são loja (`store_id`, já existia) e anúncio (`item_id`, novo nesta fase).

Ver fórmulas completas (status por `diferenca_pct`, estrelas por percentil, limiar do outlier) em `business-rules.md`.

## Gráfico semanal usa `TO_CHAR(DATE_TRUNC('week', sale_date), 'YYYY-MM-DD')`

**Nota técnica preservada**: `sale_date` em `ml_turbo_sales` é tipo `DATE` (não `TIMESTAMPTZ`), então o agrupamento semanal usa `DATE_TRUNC` diretamente sem conversão de fuso horário — ao contrário de `orders.date_created`, que é `TIMESTAMPTZ` e por isso outras queries fazem `AT TIME ZONE 'America/Sao_Paulo'` antes de truncar. Misturar os dois padrões sem essa distinção gera resultados sutilmente errados perto da virada do dia/semana.
