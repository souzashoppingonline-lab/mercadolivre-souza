# API REST

> Escopo: contrato de todos os endpoints HTTP expostos pelo backend. Único ponto de acesso a dados permitido para o frontend (via `js/db.js` — ver `frontend.md`). Nenhum destes handlers chama a API do Mercado Livre, exceto os marcados explicitamente. **Sempre que uma rota nova for criada em `routes/*.js`, documente-a aqui e adicione o método correspondente em `js/db.js` na mesma tarefa.**

Prefixos montados em `server.js`: `/api` (routes/api.js), `/api/turbo` (routes/turbo.js), `/webhooks` (routes/webhookGateway.js), `/auth` e `/ml` (routes/auth.js — ver `mercadolivre.md`).

## Dashboard
| Rota | Descrição |
|---|---|
| `GET /api/dashboard/kpis` | vendas/pedidos de hoje, perguntas pendentes, anúncios ativos. Cache Redis 30s (`kpis:summary`) |
| `GET /api/dashboard/chart?period=N` | série diária de pedidos/receita, últimos N dias |
| `GET /api/dashboard/top-products?limit=N` | produtos mais vendidos por receita |
| `GET /api/dashboard/alerts` | itens com estoque ≤ 5 |
| `GET /api/dashboard/resumo-ontem` | pedidos/receita/itens de ontem, por loja e por logística — usa `reports.getResumoDiarioData()` (mesma função do resumo diário Telegram/e-mail, ver `workers.md`). Consumido por `pages/top-vendas-online.html` |
| `GET /api/dashboard/top-vendas-dia` | top 10 itens mais vendidos (unidades) nas últimas 24h, com loja — usa `reports.getTopVendas({hours:24, limit:10})`, mesma função do e-mail diário |
| `GET /api/dashboard/resumo-semanal` | comparativo 7 dias vs. 7 dias anteriores (pedidos/receita/margem) + curva ABC top 10 — usa `reports.getResumoSemanal()`, mesma função do e-mail semanal |
| `GET /api/dashboard/alertas-dia` | `outliers` (lojas cujo faturamento de ontem fugiu de ±1.5 desvio-padrão da média histórica — mesma lógica/limiar de `tg_outlier`, via `reports.getOutliersOntem()`) + `estoque_critico` (itens mais vendidos nas últimas 24h com `available_quantity <= 15` — `reports.getEstoqueCriticoTopVendas()`) |

## Anúncios / Produtos
| Rota | Descrição |
|---|---|
| `GET /api/anuncios?status&search&store_id&days` | lista + summary (total/active/paused/closed) |
| `GET /api/produtos?search&sortBy&days&store_id` | lista com vendas/receita do período + promoção ativa via `LEFT JOIN LATERAL promotions` |
| `GET /api/produtos/:id/detalhe` | item + últimas 6 alterações (`item_changes`) + vendas diárias 30d + visitas 30d |
| `GET /api/produtos/performance?store_id&days&sort` | agrupado por `parent_item_id` (variações somadas): pedidos, receita, visitas, conversão% |
| `GET /api/produtos/:id/historico-diario?days&store_id` | série diária mesclada de visitas + vendas para um item (e variações) |
| `PATCH /api/items/:id/custo { cost }` | atualiza `items.cost` |
| `GET /api/custos/:sku` / `PATCH /api/custos/:sku { cost }` | custo por SKU (`sku_costs`), também espelha em `items.cost` |
| `GET /api/anuncios/:id/visitas?days` | série de visitas (`item_visits`) |
| `GET /api/items/:item_id/promotion?store_id` | **chama a API do ML em tempo real** (`mlClient`) — verifica `sale_price`, `promotions[]`, `original_price`, `deal_ids`, endpoint `/items/:id/promotions` e `seller-promotions` para detectar se o item está em promoção. Usado sob demanda no modal de detalhe, não em listagens |
| `GET /api/alertas/anuncios-problema?store_id&level&sort` | itens ativos + score de qualidade (`item_performance`) + pedidos/receita 30/15/7d |
| `POST /api/alertas/anuncios-performance/sync { store_id, limit }` | dispara em background a chamada `/item/:id/performance` na API do ML para itens sem score ou desatualizados (>24h); roda com mutex `perfSyncRunning` |

## Qualidade de Anúncio (SEO Score — `item_seo_score`, ver `database.md` e `business-rules.md`)
| Rota | Descrição |
|---|---|
| `GET /api/qualidade-anuncio?store_id&category_id&brand&is_full&catalog_listing&shipping_type&sort` | lista itens com score + `summary` agregado (`total`, `synced`, `avg_score`, `sem_gtin`, `sem_video`, `sem_catalogo`, `atributos_incompletos`, `full`, `nao_full`); Top10/Piores10 **não** vêm do backend — o frontend ordena o mesmo array `items` recebido (mesma convenção de outras telas de ranking) |
| `GET /api/qualidade-anuncio/:itemId/historico` | série histórica do score de um item (`item_seo_score_history`) |
| `GET /api/qualidade-anuncio/historico-medio?days&store_id&category_id&brand&is_full&catalog_listing&shipping_type` | `AVG(score)` diário do conjunto filtrado — alimenta o gráfico "Evolução do SEO Score médio" (7/30/90 dias) |
| `GET /api/qualidade-anuncio/:itemId/concorrentes` | **Chama a API do ML em tempo real** (`ml.getCatalogCompetitors`) — lista os concorrentes do mesmo `catalog_product_id` (preço, logística, frete grátis, quem é o vencedor/você). Sob demanda (modal), não no job diário — mesmo padrão de `GET /api/items/:item_id/promotion`. Retorna `{competitors: [], message}` se o item ainda não tem `catalog_competition` sincronizado |

Score/buy-box calculados 1x/dia pelos jobs `sync-seo-score`/`sync-catalog-competition` (ver `workers.md`), nunca em tempo real — as rotas de listagem/histórico são leitura pura de `item_seo_score`/`catalog_competition`, sem chamar a API do ML (exceto a rota de concorrentes acima, sob demanda). A listagem principal (`GET /api/qualidade-anuncio`) também traz `buybox_status`/`price_to_win`/`winner_item_id`/`winner_price`/`buybox_boosts_missing` via `LEFT JOIN catalog_competition` e `summary.perdendo_buybox` — só preenchido pra itens `catalog_listing=true`. Ver `database.md`/`decisions.md`.

## Pedidos / Vendas (webhook-driven — tabela `orders`)
| Rota | Descrição |
|---|---|
| `GET /api/pedidos?status&period` | lista + summary por status. `period`: `hoje`, `ontem` ou N dias |
| `GET /api/pedidos/:id/detalhes` | pedido completo com cálculo de margem (custo, imposto, tarifa, fretes) |
| `PATCH /api/pedidos/:id/frete-vendedor { cost }` | grava `shipping_seller_cost` manualmente |
| `GET /api/vendas/diarias?days` | série diária, com estimativa fixa `liquido = bruto*0.88` / `taxas = bruto*0.12` (aproximação, não usa custo real por pedido) |
| `GET /api/vendas/detalhado?store_id&status&days&search&date_from&date_to` | linha a linha com margem calculada por pedido — fórmula em `finance.md` |
| `GET /api/vendas/hoje` | KPI do dia (sempre `CURRENT_DATE`, independe de filtro de período) + `projecao_mes` (run-rate simples: receita acumulada do mês ÷ dias decorridos × dias no mês), `receita_mes`, `dias_decorridos`, `dias_no_mes` |
| `GET /api/vendas/hoje-vs-ontem?store_id` | comparação até o mesmo horário do dia anterior (aritmética em UTC ajustada para BRT) |
| `GET /api/vendas/por-loja?days` | receita diária por loja, período atual vs período anterior equivalente |
| `GET /api/analises/estoque-parado?store_id&days&modo` | itens ativos sem venda no período (`modo=parado`) ou todos com contagem de vendas |
| `GET /api/analises/horarios?store_id&period` | pedidos/receita por hora do dia (fuso America/Sao_Paulo) |
| `GET /api/analises/dias-semana?store_id&days` | pedidos/receita por dia da semana |
| `GET /api/comparativos/periodos?p1&p2` | compara dois períodos (N dias ou `from|to`) |
| `GET /api/comparativos/evolucao?days&store_id` | série diária receita/pedidos |
| `GET /api/comparativos/curva-abc?store_id&period` | classificação ABC por % acumulado de faturamento (A≤80%, B≤95%, C resto) |

## Análise de Vendas do Mês (BI)
> Sem normalização por dia útil (decisão explícita — todo dia conta igual, ver `decisions.md`). Fórmulas dos insights, do status "Dia Ideal", das estrelas de sazonalidade e do outlier estatístico em `business-rules.md`.

| Rota | Descrição |
|---|---|
| `GET /api/analises/vendas-mes?year&month&store_id&item_id` | payload único com tudo que a página usa: `kpis` (receita/pedidos/ticket/crescimento% + sparkline), `mes_atual`/`mes_anterior`/`mes_retrasado` (array de 1..N dias, `receita`/`pedidos`/`ticket_medio`/`ocorrido`), `media_historica` (12 meses anteriores ao selecionado, por dia-do-mês, com `media`/`desvio`/`media_pedidos`/`media_lucro`/`maior`/`menor`/`meses_analisados`/`banda_min`/`banda_max`), `media_geral`, `ranking_top10`/`ranking_bottom10`, `insights` (tendência, aceleração, melhor/pior semana, concentração top5, acumulado atual vs. anterior, projeção de fechamento, sugestão de anúncios, sugestão de estoque), `dia_ideal` (só populado quando `year`/`month` = mês corrente real — ver `business-rules.md`), `termometro_horario` (mesma condição de `year`/`month` = mês corrente; compara a receita de hoje até o horário atual contra a média dos últimos 30 dias e contra ontem, ambas até o mesmo horário — `hora_atual`, `atual`, `media_30d.{valor,dias_analisados,diferenca,diferenca_pct,status}`, `ontem.{valor,diferenca,diferenca_pct,status}`, ver `business-rules.md`), `sazonalidade.top10`/`sazonalidade.bottom10` (dias históricos ordenados por receita média, com `ranking`/`estrelas`/`participacao_pct`). `item_id` filtra as 3 queries agregadas por `orders.item_id` (opcional, combina com `store_id`) |
| `GET /api/analises/vendas-mes/dia?date&store_id` | drill-down — pedidos de um dia específico (`YYYY-MM-DD`), usado pelo modal ao clicar num dia do heatmap/gráfico |
| `GET /api/analises/vendas-mes/dia-historico?dia&year&month&store_id` | drill-down do **drawer de sazonalidade** — para um dia-do-mês (1-31), retorna `evolucao` (receita/pedidos desse dia-do-mês nos últimos 12 meses, ano a ano) e `produtos_mais_vendidos` (top 10 por unidades nesse dia-do-mês, últimos 12 meses) |

## Perguntas / Mensagens
| Rota | Descrição |
|---|---|
| `GET /api/perguntas?status&store_id` | lista + summary (não respondidas, respondidas hoje, tempo médio de resposta) |
| `POST /api/perguntas/:id/responder { text }` | **chama a API do ML** (`mlClient.answerQuestion`) e atualiza `questions` |
| `GET /api/mensagens` | últimas 50 conversas (`messages`) |

## Clientes
| Rota | Descrição |
|---|---|
| `GET /api/clientes?store_id&search&days` | agregado por `buyer_nickname`: total de pedidos, gasto total, ticket médio, primeira/última compra |
| `GET /api/clientes/:nickname` | histórico de pedidos de um comprador |

## Lojas
| Rota | Descrição |
|---|---|
| `GET /api/lojas` | lojas **ML apenas** (lê da view `vw_ml_stores` — v17). Status de token (`token_valid`), se tem credenciais próprias |
| `PATCH /api/lojas/:id { imposto_pct }` | atualiza percentual de imposto |
| `PATCH /api/lojas/:id/credentials { ml_client_id, ml_client_secret }` | credenciais ML próprias da loja |
| `GET /api/lojas/amazon` | v17: lista contas Amazon (`id`, `nickname`, `amazon_marketplace_id`, `amazon_region`, `has_refresh_token`) |
| `POST /api/lojas/amazon { nickname, refresh_token, amazon_marketplace_id?, amazon_region? }` | v17: cadastra nova conta Amazon — `nickname`/`refresh_token` obrigatórios; gera `store_id` sintético (faixa `9000000001`+). Resposta inclui aviso de que o worker precisa ser reiniciado para sincronizar a conta nova (sem hot-reload ainda, ver `todo.md`) |
| `DELETE /api/lojas/amazon/:id` | v17: remove conta Amazon (só linhas com `marketplace_id=AMAZON` — não afeta lojas ML mesmo que o `:id` colida) |

## Dashboard Amazon (`routes/amazon.js`, montado em `/api/amazon`)
> 100% isolado do pipeline ML: consulta `orders`/`items`/`stores` direto, filtrando `marketplace_id = (SELECT id FROM marketplaces WHERE code='AMAZON')` — não usa as views `vw_ml_*` (que excluem Amazon de propósito) nem nenhuma query já existente do ML. Consumido só por `pages/dashboard-amazon.html`.

| Rota | Descrição |
|---|---|
| `GET /api/amazon/kpis` | `vendas_hoje` (soma `total_amount` de hoje, exclui `cancelled`), `pedidos_hoje` (contagem hoje), `produtos_ativos` (`items.status='active'`) |
| `GET /api/amazon/pedidos` | até 200 pedidos Amazon mais recentes (`id`, `cliente`, `sku`, `valor`, `status`, `data`, `conta`) |
| `GET /api/amazon/produtos?status` | até 200 itens Amazon (`sku`, `title`, `estoque`, `price`, `status`); `status=active` filtra só anúncios ativos (usado por `pages/amazon-anuncios.html`), sem o parâmetro retorna o catálogo completo (`pages/amazon-produtos.html`). Campo `note` explica quando vazio — catálogo de produtos Amazon ainda não é sincronizado, só pedidos (ver `todo.md`) |
| `GET /api/amazon/status` | `ultima_sincronizacao` (`MAX(last_synced_at)` de `marketplace_sync_state`), `contas_conectadas`/`contas_total` (`stores` com `refresh_token`), `ultimo_erro` (sempre `null` hoje — sem tracking estruturado de erro de polling ainda) |

## Dashboard Shopee (`routes/shopee.js`, montado em `/api/shopee`)
> 100% isolado do pipeline ML: mesmo padrão exato do Dashboard Amazon acima, filtrando `marketplace_id = (SELECT id FROM marketplaces WHERE code='SHOPEE')`. Consumido só por `pages/dashboard-shopee.html`. Acessível também pelo papel de login restrito `shopee-demo` (ver `auth-staff.md`).

| Rota | Descrição |
|---|---|
| `GET /api/shopee/kpis` | mesmos campos do Amazon (`vendas_hoje`, `pedidos_hoje`, `produtos_ativos`) |
| `GET /api/shopee/pedidos` | até 200 pedidos Shopee mais recentes (`id`, `cliente`, `sku`, `valor`, `status`, `data`, `conta`) |
| `GET /api/shopee/produtos?status` | até 200 itens Shopee (`sku`, `title`, `estoque`, `price`, `status`). Campo `note` explica quando vazio — catálogo de produtos Shopee (Product API) ainda não é sincronizado, só pedidos (ver `todo.md`) |
| `GET /api/shopee/status` | mesmos campos do Amazon (`ultima_sincronizacao`, `contas_conectadas`/`contas_total`, `ultimo_erro`) |

## Alertas
| Rota | Descrição |
|---|---|
| `GET /api/alertas/reposicao?threshold&store_id` | itens com estoque ≤ threshold (padrão 15), com resumo por faixa (zero/critical≤3/low≤10/medium) |
| `GET /api/alertas/cancelamentos` | últimos 100 pedidos cancelados |
| `GET /api/alertas/devolucoes?store_id&q&date_from&date_to` | devoluções + summary por status. `date_from`/`date_to` filtram por `returns.date` — usados pelos botões de atalho Hoje/Ontem/7/15/30 dias em `pages/devolucoes.html`. Cada linha inclui `reason_detail` (motivo traduzido, `claim_reasons` join com fallback pro código cru), `stage`/`type`/`last_updated` (extraídos de `returns.raw_data`), `raw_data` completo (JSON bruto da claim, pro modal de detalhe mostrar "tudo"), `prejuizo` (valor manual, `null` se não lançado), e o produto/pedido associado via `LEFT JOIN vw_ml_orders`/`vw_ml_items` (`item_id`, `item_title`, `item_thumbnail`, `item_permalink`, `order_quantity`, `order_amount`, `shipping_type`, `order_date`) — `order_amount` é o valor real a mostrar como "Valor da devolução" (`returns.amount` também é preenchido com o mesmo valor desde a correção de `resolveReturnAmount()`, ver `decisions.md`). `summary` inclui `prejuizo_total` (soma de `prejuizo` das linhas com valor lançado, dentro do filtro atual), `prejuizo_qtd` (quantas linhas têm prejuízo lançado), `pedidos_total`/`taxa_devolucao_pct` (ver acima), `ranking_produtos` (top 10 itens por nº de devoluções no período, com `item_id`/`conta` (loja) já inclusos junto de `pedidos`/`taxa_pct` do próprio item — só busca pedidos dos `item_id` que aparecem nas devoluções, não o catálogo inteiro), `taxa_por_loja` (array por `store_id`, devoluções/pedidos/taxa — pra comparar contas lado a lado quando `store_id` não é informado) e `pedidos_por_logistica` (array `{shipping_type, pedidos}` com o valor cru de `orders.shipping_type`; o bucket Flex/Mercado Envios/Full é feito no frontend com `logLabel()`, mesma função já usada na tabela — ver `business-rules.md` e `decisions.md`) |
| `PATCH /api/alertas/devolucoes/:id/note { note }` | anotação manual em uma devolução |
| `PATCH /api/alertas/devolucoes/:id/prejuizo { prejuizo }` | valor de prejuízo digitado manualmente (R$) — string vazia/inválida grava `NULL` (não lançado), não zero |
| `GET /api/alertas/devolucoes/evolucao?days&store_id` | série diária zero-fill (`days` 1-90, padrão 30) — `dias: [{date, devolucoes, pedidos, taxa_pct}]`, usada pelo gráfico "Evolução da Taxa de Devolução". Independente do filtro de data da tabela principal (só respeita `store_id`), mesmo padrão de `GET /api/embalagem/historico` |
| `GET /api/alteracoes?store_id&days&limit` | trilha de `item_changes` com título/thumbnail do item |

## Publicidade (exploratório)
| Rota | Descrição |
|---|---|
| `GET /api/publicidade` | **chama a API do ML** testando múltiplos endpoints de advertising por loja até um responder OK; usado como diagnóstico, não como fonte estável de dados |

## Webhooks / Schedule (operação/observabilidade)
| Rota | Descrição |
|---|---|
| `GET /api/webhooks/logs?topic&limit` | últimos logs de `webhook_logs` |
| `GET /api/webhooks/config` | contadores do dia + status da config do Telegram |
| `GET /api/schedule/jobs` | estado atual de cada sync (`schedule_jobs`) |
| `POST /api/schedule/jobs/:name/trigger` | publica comando no canal Redis `worker:cmd` para disparar um sync manualmente — nomes aceitos: `dailySync`, `syncVendas`, `syncMetricas`, `syncReturns`, `syncParentItems`, `syncVisitas`, `syncPrecos`, `syncScores`, `syncNotionTarefas`, `syncTopVendas`, `emailDailyReports`, `emailRelatorioSemanal`, `checkOutlierEstatistico`, `syncShippingStatus` (v33, botão "Sincronizar Entregas" em `conciliacao-bancaria.html`) |
| `GET /api/schedule/worker-logs` | **SSE** — stream de `journalctl -u ml-worker-novo -f` (produção; depende do ambiente ter systemd/journalctl) |
| `GET /api/schedule/runs?job&limit` | histórico de execuções (`schedule_runs`) |
| `GET /api/schedule/logs?limit` | alias de leitura crua de `webhook_logs` |

## Configuração Telegram
| Rota | Descrição |
|---|---|
| `GET /api/config/telegram` | config atual (token mascarado) |
| `PATCH /api/config/telegram { bot_token, chat_id, tg_*, tg_interval, silence_start, silence_end }` | grava em `app_config` |
| `POST /api/config/telegram/test { message }` | envia mensagem de teste |

## Configuração E-mail (Resend)
> Credencial (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`RESEND_TO_EMAIL`) só via `.env` do servidor — estas rotas só leem/gravam os toggles liga/desliga de cada relatório em `app_config`.

| Rota | Descrição |
|---|---|
| `GET /api/config/email` | `{ configured, email_resumo, email_topvendas, email_semanal }` — `configured` reflete se `RESEND_API_KEY`+`RESEND_TO_EMAIL` estão no `.env` |
| `PATCH /api/config/email { email_resumo?, email_topvendas?, email_semanal? }` | grava os toggles em `app_config` |
| `POST /api/config/email/test` | envia e-mail de teste para `RESEND_TO_EMAIL` |

## Promoções
| Rota | Descrição |
|---|---|
| `GET /api/promocoes?store_id&days` | histórico de `promotions` + resumo (entrou/saiu hoje) |

## Monitor (infra do servidor)
| Rota | Descrição |
|---|---|
| `GET /api/monitor/metrics` | CPU/mem/disco via `top`/`free`/`df` (shell — só funciona em Linux com esses binários) |
| `GET /api/monitor/security` | status `fail2ban` + últimos logins SSH via `last` |

## Assistente IA (MCP)
| Rota | Descrição |
|---|---|
| `POST /api/mcp/chat { message, store_id }` | monta contexto (KPIs, top produtos, pendências, estoque baixo, cancelamentos) e chama a API da Anthropic (`claude-haiku-4-5-20251001`) — requer `ANTHROPIC_API_KEY` |
| `POST /api/mcp/docs { query, language, siteId, limit }` | proxy para o MCP oficial de documentação do Mercado Livre (`mcp.mercadolibre.com`), autenticado com o token de qualquer loja conectada |

## `/api/turbo/*` — Vendas ML Turbo

Ver `finance.md` para o significado de cada campo e o formato da planilha.

| Rota | Descrição |
|---|---|
| `POST /api/turbo/import` (multipart `file`) | parseia `.xlsx/.xls/.csv`, autodetecta linha de cabeçalho e mapeia colunas por alias, faz upsert em `ml_turbo_sales` por `sale_id` |
| `GET /api/turbo/kpis?date_from&date_to&account&sku&state&order_status` | KPIs agregados + resultado do dia + ROI |
| `GET /api/turbo/sales?...&page&limit` | listagem paginada |
| `GET /api/turbo/charts?date_from&date_to&account&order_status` | 10 séries agregadas em paralelo (diária, por estado, por conta, top receita/margem, baixa margem, por modal de envio, semanal, top quantidade, por status) |
| `GET /api/turbo/filters-meta` | valores distintos para popular filtros do frontend |

## `/webhooks/*` — ver `mercadolivre.md` e `websocket.md`

| Rota | Descrição |
|---|---|
| `POST /webhooks/ml` | entrada de webhooks do Mercado Livre — responde 200 imediato, enfileira no BullMQ |
| `POST /webhooks/telegram` | recebe replies do bot Telegram para responder perguntas ML diretamente do chat |

## `/auth/*` e `/ml/*` — ver `mercadolivre.md`

`GET /auth/config`, `GET /auth/login`, `GET /auth/callback` (+ alias `/ml/callback`).

## Agenda Trello (`routes/tasks.js`, montado em `/api/tasks`)
> Módulo independente — só lê/grava `tasks`/`task_comments` (v19), nunca `orders`/`items`. Geração automática de cartões fica em `taskEngine.js` (ver `task-engine.md`), esta rota é só CRUD + filtros. Consumido por `pages/agenda-trello.html`.

| Rota | Descrição |
|---|---|
| `GET /api/tasks/summary` | painel superior: `total` (exclui `excluido`), `pendentes` (`a_fazer`), `em_andamento`, `finalizadas_hoje` (`finalizado` com `completed_at` hoje), `criticas` (`priority='alta'`, fora de `finalizado`/`excluido`), `atrasadas` (`due_date < now()`, fora de `finalizado`/`excluido`) |
| `GET /api/tasks?marketplace&store_id&assigned_to&priority&source&board_column&date_from&date_to` | lista de cartões com todos os filtros da Agenda Trello, join com `stores`/`marketplaces` para nome/código, mais `comment_count`/`last_comment_text`/`last_comment_at` (subqueries correlacionadas em `task_comments`, usam o índice `idx_task_comments_task`) — permite mostrar status do cartão sem abrir o modal, ver `frontend.md` |
| `POST /api/tasks { title, description?, marketplace?, store_id?, priority?, due_date?, assigned_to?, tags? }` | cria cartão manual (`source='manual'`, `board_column='a_fazer'`) |
| `PATCH /api/tasks/:id { board_column?, title?, description?, priority?, assigned_to?, due_date?, tags? }` | edição parcial; mover pra `board_column='finalizado'` seta `status='concluido'`+`completed_at=now()`, mover pra qualquer outra coluna limpa os dois (usado tanto pelo drag-and-drop quanto pelo modal de edição) |
| `DELETE /api/tasks/:id` | exclusão definitiva (`DELETE FROM tasks`, `task_comments` cai junto via `ON DELETE CASCADE`) — só aceita se o cartão já está com `board_column='excluido'` (400 caso contrário); o botão correspondente no frontend só aparece nesse estado |
| `GET /api/tasks/:id/comments` | comentários do cartão, ordenados por data |
| `POST /api/tasks/:id/comments { author?, text }` | adiciona comentário |

## Embalagem (`routes/embalagem.js`, montado em `/api/embalagem`)
> Módulo independente — só lê `orders`/`items` (leitura, nunca escreve nelas), escreve/lê `packing_videos`. Ver `embalagem.md`.

| Rota | Descrição |
|---|---|
| `GET /api/embalagem/pedido/:shippingId` | busca pedido(s) por `orders.shipping_id` — pode retornar mais de 1 (envio/pack com vários pedidos); inclui `thumbnail`/`title`/`quantity`/`buyer_nickname`/`store_nickname`, mais `unit_price`/`status`/`shipping_type`/`date_created`/`available_quantity` (estoque atual) e `seller_sku`/`variation_attributes` extraídos de `orders.raw_data` — tudo sem chamar a API do ML. Também retorna `already_packed` (`{id, created_at}` do vídeo mais recente já salvo pra esse `shipping_id`, ou `null`) — usado pelo frontend pra avisar antes de gravar de novo |
| `POST /api/embalagem/finalizar` (multipart: `video`, `shipping_id`, `order_ids` (JSON), `duration_seconds`, `store_id`) | salva o vídeo gravado em `server/storage/embalagem-videos/YYYY-MM-DD/` e grava a linha em `packing_videos` |
| `GET /api/embalagem/videos?order_id&buyer&date_from&date_to&store_id` | busca vídeos salvos (abas "Buscar vídeos" e "Conferência do Dia" — a segunda sempre fixa `date_from`/`date_to` no dia corrente); cada linha inclui `sample_shipping_type` (do 1º pedido do envio) — usado pelos cards de resumo Flex/Mercado Envios/por loja na aba Conferência do Dia |
| `GET /api/embalagem/por-hora?date=YYYY-MM-DD&store_id` | quantidade de bipagens por hora (0-23, zero-fill) num dia — usado pelo gráfico de colunas "dia selecionado vs. dia anterior" da aba Conferência do Dia |
| `GET /api/embalagem/videos-por-pedidos?order_ids=1,2,3` | lookup em lote (1 chamada, não N+1) — devolve `{order_id: {id, created_at}}` só pros pedidos que têm vídeo. Usado pelo botão "Assistir" na tela de Devoluções (`pages/devolucoes.html`) |
| `GET /api/embalagem/historico?days=30&store_id` | série diária zero-fill (`days` entre 1-90, default 30) — `count` (bipagens no dia) e `duration_sum`/`duration_orders` (pra calcular tempo médio/pedido no frontend, mesmo padrão SUM/SUM do card da Conferência do Dia). Usado pela aba Histórico |
| `GET /api/embalagem/videos/:id/file` | stream do arquivo de vídeo (`res.sendFile`, suporta `Range` — necessário pro player HTML5 avançar/voltar) |

## Conciliação Bancária (`routes/api.js`, ver `conciliacao-bancaria.md`)

| Rota | Descrição |
|---|---|
| `GET /api/conciliacao/resumo-lojas` | total a receber (`released != 'yes'`) agrupado por loja — só devolve lojas com ≥1 pagamento pendente (`HAVING`). Usado pelos cards por loja, que só aparecem na tela quando há 2+ lojas com pendência (1 loja só já é redundante com o card "Total Pendente") |
| `POST /api/conciliacao/pagamentos/:paymentId/reprocessar` | ação pontual (botão "Reprocessar" no modal, não leitura de listagem — `mlClient` importado localmente na rota, mesmo padrão de "responder pergunta", ver `architecture.md` regra 2) — refaz o `UPDATE` de `sync-payment-releases` (pagamento via `/collections/:id`) **e** o de `sync-shipping-status` (entrega via `/shipments/:id`, se o pedido tem `shipping_id`), sob demanda pra 1 pedido só. Como é 1 pedido (não 200), não esbarra no rate limit em lote do "Sincronizar Entregas". A consulta de entrega é isolada em try/catch: se falhar (ex: 429), o reprocesso do pagamento já foi persistido e a resposta traz `{ok:true, shipping_error:'...'}` pro modal avisar |
| `GET /api/conciliacao/agenda-recebimentos?store_id` | agrupa `ml_payments` com `released != 'yes'` por dia de `money_release_date` (fuso São Paulo) — `{dias: [{data, qtd_pagamentos, valor_liquido, valor_bruto}]}`. Granularidade diária; agregação "hoje/amanhã/7 dias/30 dias" é feita no cliente, não pré-calculada aqui |
| `GET /api/conciliacao/pagamentos/:paymentId` | 1 pagamento completo (`SELECT p.*` + `buyer_nickname`/`title`/`order_total_amount`/`item_id`/`store_nickname`/`shipping_status`/`shipping_substatus`/`date_ready_to_ship`/`date_shipped`/`date_delivered`/`shipping_last_updated` via JOIN) — usado pelo modal de detalhe da grid, inclui `raw_data` (payload bruto de `/collections/:id`) pra auditoria |
| `GET /api/conciliacao/pagamentos?store_id&released&date_from&date_to&q&entrega&logistica&sort&dir&page&limit` | grid paginada (`LIMIT`/`OFFSET` reais, `COUNT(*)` separado sobre todo o range filtrado — mesmo padrão do fix de `vendas/detalhado`) — `JOIN orders`/`stores` pra trazer `buyer_nickname`/`title`/`store_nickname`/`shipping_status`/`shipping_substatus`/`date_ready_to_ship`/`date_shipped`/`date_delivered`/`shipping_last_updated`/`shipping_type` (v33; `shipping_type` é a logística — Full/Flex/Mercado Envios/Coleta, mesmo mapeamento de `fmtLogistica` em `worker.js`). `logistica` ∈ `full`\|`flex`\|`me`\|`coleta`, traduzido server-side pra padrões `ILIKE ANY` via `LOGISTICA_BUCKETS` (`shipping_type` não tem conjunto fechado de valores exatos, filtra por substring — mesmo motivo de `fmtLogistica` usar `.includes()`). `date_from`/`date_to` filtram por `date_approved::date`. `q` busca em `order_id`/`payment_id`/`buyer_nickname` (ILIKE). `entrega` ∈ `aguardando`\|`preparando`\|`transito`\|`entregue`\|`cancelado`\|`nao_entregue` (bucket de UI, traduzido server-side pra lista de status crus via `SHIPPING_STATUS_BUCKETS` — ver `business-rules.md` pro mapeamento completo). `sort` ∈ `data`\|`valor`\|`liquido`\|`status`\|`diferenca`\|`liberacao`\|`entrega` (whitelist, nunca interpola direto). `taxas` = soma de `marketplace_fee+mercadopago_fee+discount_fee+coupon_fee+finance_fee` (sub-estima o custo real — ver `diferenca`). `diferenca` = `transaction_amount - net_received_amount` (fallback 0 se `net_received_amount` ainda nulo) — é o valor exibido na tela como "taxa da venda" de fato, mais confiável que `taxas` porque os 5 campos de taxa do Mercado Pago costumam vir zerados mesmo quando o valor líquido é bem menor que o bruto (a comissão do Mercado Livre em si não está detalhada em nenhum desses campos). `{payments: [...], total, page, limit}` |

## `/auth/staff/*` (`routes/staffAuth.js`) — ver `auth-staff.md`
> Rotas sempre públicas (fora do gate `requireStaffAuth`, senão login ficaria impossível). Demais rotas do sistema passam pelo gate quando `STAFF_AUTH_ENABLED=true`.

| Rota | Descrição |
|---|---|
| `POST /auth/staff/login` (`{username, password}`) | valida bcrypt, assina JWT, grava cookie httpOnly `staff_session` (`STAFF_SESSION_DAYS`, default 180) |
| `POST /auth/staff/logout` | limpa o cookie |
| `GET /auth/staff/me` | `{username, role}` da sessão atual, ou `401` |

## `/auth/shopee/*` — ver `shopee.md`

| Rota | Descrição |
|---|---|
| `GET /auth/shopee/config` | diagnóstico — mostra `partner_id`/`redirect_uri`/ambiente configurados (`partner_key` só indica se está setada, nunca expõe o valor) |
| `GET /auth/shopee/login` | monta a URL de autorização assinada (`shop/auth_partner`) e redireciona o seller para lá |
| `GET /auth/shopee/callback` | recebe `?code&shop_id`, troca por `access_token`/`refresh_token` (`auth/token/get`) e cria/atualiza a linha em `stores` (`marketplace_id=SHOPEE`, id sintético `9100000001`+). Resposta avisa que o worker precisa ser reiniciado pra sincronizar a conta nova (mesma limitação hoje da Amazon) |
