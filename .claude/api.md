# API REST

> Escopo: contrato de todos os endpoints HTTP expostos pelo backend. Único ponto de acesso a dados permitido para o frontend (via `js/db.js` — ver `frontend.md`). Nenhum destes handlers chama a API do Mercado Livre, exceto os marcados explicitamente. **Sempre que uma rota nova for criada em `routes/*.js`, documente-a aqui e adicione o método correspondente em `js/db.js` na mesma tarefa.**

Prefixos montados em `server.js`: `/api` (routes/api.js), `/api/turbo` (routes/turbo.js), `/webhooks` (routes/webhookGateway.js), `/auth` e `/ml` (routes/auth.js — ver `mercadolivre.md`).

## Dashboard
| Rota | Descrição |
|---|---|
| `GET /api/dashboard/por-marketplace` | vendas/pedidos de **hoje quebrados por marketplace** (ML/Shopee) — cards no dashboard. `{marketplaces:[{code,name,pedidos,vendas}]}`. `COALESCE(marketplace_id, ML)` trata pedido ML antigo sem marketplace como ML, pro somatório bater com o KPI consolidado |
| `GET /api/dashboard/kpis` | vendas/pedidos de hoje **(consolidado ML + Shopee, tabela base `orders`)** — Amazon fica de FORA (`marketplace_id IS DISTINCT FROM AMAZON`) enquanto a integração não está em produção, pra pedidos de sandbox/mock não inflarem o KPI; bate com os cards de `/dashboard/por-marketplace`. Perguntas pendentes + anúncios ativos seguem ML-only via `vw_ml_*`. Cache Redis 30s (`kpis:summary`, invalidado pelos workers ML e Shopee). Ver `decisions.md` |
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
| `GET /api/vendas/diarias?days` | série diária **(consolidado — todos os marketplaces, base `orders`)** pro gráfico do dashboard, com estimativa fixa `liquido = bruto*0.88` / `taxas = bruto*0.12` (aproximação, não usa custo real por pedido) |
| `GET /api/vendas/detalhado?store_id&status&days&search&date_from&date_to` | linha a linha com margem calculada por pedido — fórmula/precedência da taxa em `finance.md`. Tarifa/frete vendedor por pedido em 3 níveis (`LEFT JOIN LATERAL` por `order_id`): **1)** Conciliação (`mp_account_movements`, separa `mp_fee_amount`/`shipping_fee_amount`); **2)** `ml_payments` tempo real (`transaction_amount−net_received_amount`, tudo na tarifa, frete=0); **3)** `orders.ml_fee`/`shipping_seller_cost`. Cada linha traz `fonte_taxa` (`conciliacao`\|`pagamento`\|`pedido`) e `tem_conciliacao`; `summary` traz `pedidos_conciliados` (cobertura de taxa real) |
| `GET /api/vendas/hoje` | KPI do dia (sempre `CURRENT_DATE`, independe de filtro de período) + `projecao_mes` (run-rate simples: receita acumulada do mês ÷ dias decorridos × dias no mês), `receita_mes`, `dias_decorridos`, `dias_no_mes` |
| `GET /api/vendas/hoje-vs-ontem?store_id` | comparação até o mesmo horário do dia anterior (aritmética em UTC ajustada para BRT) **(consolidado — todos os marketplaces, base `orders`/`stores`/`items`)**. A tela mostra só receita+pedidos; o `lucro` calculado usa campos ML (0 no Shopee) mas não é exibido |
| `GET /api/vendas/por-loja?days` | receita diária por loja, período atual vs anterior equivalente. Também devolve `devolucoes:[{store_id,loja,devolucoes,qtd}]` — devoluções casadas com a VENDA do período (pedido não cancelado), valor = `COALESCE(NULLIF(returns.amount,0), total_amount)`. A página mostra Bruto / Devoluções / Líquido |
| `GET /api/vendas/margem?days` ou `?date_from&date_to` (opc. `frete_comprador=1`) | **Margem de Contribuição por loja** (mesma fórmula do Mercado Turbo): `Aprovadas − Custo − Imposto − Tarifa − Frete Vendedor`. Devolve `{lojas:[{store_id,loja,faturamento,canceladas,aprovadas,qtd_aprovadas,custo,imposto,tarifa,frete_vendedor,frete_comprador,pedidos_conciliados,tem_conciliacao,margem,margem_pct}], considerar_frete_comprador}`. **Tarifa e frete do vendedor por pedido em 3 níveis** (mesma precedência de `/vendas/detalhado`, ver `finance.md`): 1) Conciliação (`mp_account_movements`, separa tarifa/frete); 2) `ml_payments` tempo real (`transaction_amount−net_received_amount`, tudo na tarifa, frete=0); 3) `orders.ml_fee`/`shipping_seller_cost`. `pedidos_conciliados`=cobertura de taxa real (nível 1 ou 2); `tem_conciliacao`=`bool_or` de ter taxa real. `custo=items.cost×qtd`, `imposto=total_amount×stores.imposto_pct/100`. Frete do comprador só é abatido com `frete_comprador=1` (toggle, igual ao Turbo). Só pedidos não cancelados |
| `GET /api/alertas/ruptura?janela&dias&min_venda_dia&store_id` | **Ruptura iminente** (`reports.getRupturaEstoque`): itens que vendem bem e vão acabar. `dias_restantes = estoque ÷ (unidades na janela ÷ janela)`, velocidade REAL de `vw_ml_orders`. Filtra `venda_dia ≥ min_venda_dia` (default 0.2) e `dias_restantes < dias` (default 7, janela 30). Devolve `{items:[{...,venda_dia,dias_restantes,sugestao_compra}], janela, dias}`, ordenado por urgência. Seção na página Reposição + alerta Telegram diário. Ver `business-rules.md` |
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
| `DELETE /api/perguntas/:id` | exclui a pergunta: tenta `mlClient.deleteQuestion` (o ML só deixa apagar não respondidas) e remove a linha local. Se o ML recusar, remove só localmente com `ml_deleted:false` + `ml_error`. `:id` é o `ml_id` |
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
| `GET /api/shopee/lojas` | lojas Shopee cadastradas — alimenta o seletor de loja das páginas (multi-loja) **e** a página Lojas (`pages/shopee-lojas.html`). Campos base: `id`, `nickname`, `shopee_shop_id`, `conectada`. Métricas por loja (LEFT JOIN, `marketplace_id=SHOPEE`): `token_expires_at`, `token_valid`, `updated_at`, `total_pedidos`, `pedidos_mes`, `faturamento_mes`, `produtos_ativos` |
| `POST /api/shopee/ia-socio?store_id` | IA Sócio — monta contexto Shopee (vendas hoje×ontem×7d, top anúncios, estoque baixo, promoções vencendo, problemas, cobertura de custos) e chama a API do Claude (`ANTHROPIC_API_KEY`, model haiku-4-5). Retorna `{analise, contexto}`. 503 se sem chave |
| `GET /api/shopee/performance?store_id&dias` | performance por anúncio (dias=30 default) — `{rows:[{item_id,title,thumbnail,sku,pedidos,unidades,faturamento,lucro,margem_pct,custo_completo,visitas:null,conversao:null}], nota_visitas}`. Ordenado por faturamento. Visitas/conversão null (Open API Shopee não expõe) |
| `GET /api/shopee/executivo?store_id&dias` | KPIs executivos Shopee (dias=0 hoje) — `{faturamento, pedidos, ticket_medio, lucro, margem_pct, custo, liquido, taxa_pct, pedidos_com_custo, custo_completo}`. Lucro = líquido escrow (ou estimado por `escrowFeePct`) − custo (`shopee_item_cost`) |
| `GET /api/shopee/score?store_id&q` | score de qualidade 0–100 por anúncio (calculado do `shopee_item_data.raw` via `shopeeScore.scoreItem`, sem chamar a Shopee) — `{rows:[{item_id,title,thumbnail,score,nivel,faltando:[{nome,dica,peso}],resumo}], resumo:{total,media,otimo,bom,regular,ruim}}`. Piores primeiro |
| `GET /api/shopee/devolucoes?store_id&status&dias&q` | tabela de devoluções (`shopee_returns`) com filtros — `{rows:[{return_sn,order_sn,item_name,comprador,motivo,texto,valor,status,data_ms,conta}], status_list:[...], resumo:{total,abertas,valor_total}}` |
| `GET /api/shopee/problemas?store_id` | Painel de Problemas Shopee — `{categorias:{pedidos_atrasados,anuncios_pausados,sem_estoque,sem_imagem,pedidos_cancelados,reclamacoes,reembolsos}:{total,itens[],acao}, indisponiveis:[]}`. reclamacoes/reembolsos de `shopee_returns` (v42). Tudo `marketplace_id=SHOPEE` |
| `GET /api/shopee/promocoes/:tipo/:promoId/itens` | anúncios dentro de uma promoção (modal). Desconto: `get_discount` → item_list (com `promo_price`); voucher: `item_id_list` ou escopo `loja`. Enriquece com título/foto de `items`. `{nome, tipo, escopo:'itens'\|'loja', itens:[{item_id,title,thumbnail,price,promo_price}], nota?}` |
| `GET /api/shopee/promocoes?store_id&tipo` | promoções Shopee (`shopee_promotions`) com prazos — `{rows:[{tipo,promo_id,name,code,start_ms,end_ms,desconto,status,conta}], resumo:{ativas,agendadas,vencendo_24h}}`. Status recalculado na hora. Preenchido pelo job `syncShopeePromos` |
| `GET /api/shopee/precificador?store_id&q&margem&taxa_pct&taxa_fixa` | itens+variações com custo (`shopee_item_cost`), preço atual, margem atual e **preço sugerido** = `(custo+taxa_fixa)/(1−taxa%−margem%)`. `taxa_pct` default = taxa efetiva do escrow (`escrowFeePct`, senão 14%). Retorna `{rows, taxa_pct, taxa_fixa, margem, fee_escrow}` |
| `POST /api/shopee/custo` `{item_id,model_id,cost}` | salva o custo de uma variação (upsert em `shopee_item_cost`) |
| `GET /api/shopee/estoque-preco?store_id&q` | itens Shopee com variações (do espelho `shopee_item_data`) pra grade editável — `{rows:[{item_id,title,thumbnail,conta,item_sku,has_model,variation_count,stock_total,price_min,price_max,models}]}`. Não bate na Shopee (rápido) |
| `POST /api/shopee/anuncios/aplicar` `{changes:[{item_id,model_id,price?,stock?}]}` | **ESCRITA** — grava preço/estoque em massa na Shopee (`update_price`/`update_stock`, agrupa por item) e atualiza o espelho local. Retorna `{ok, aplicados, total, resultados:[{item_id,ok,error?}]}` |
| `PATCH /api/shopee/lojas/:id` `{nickname}` | renomeia a loja Shopee. `nickname` é o nome exibido em TODAS as telas (chat/vendas/pedidos/financeiro leem `s.nickname AS conta`) — é "o novo nome da loja". Valida `marketplace_id=SHOPEE`; não toca token/sync. Retorna `{ok, nickname}` |
| `GET /api/shopee/vendas?store_id&dias` | Vendas Totais agregadas no período (`dias` default 30, máx 365; `store_id` opcional filtra uma loja, senão agrega todas). `{resumo:{vendas,pedidos,cancelados,ticket_medio,vendas_hoje,pedidos_hoje,dias}, por_dia:[{dia,pedidos,vendas}], por_loja:[{store_id,nickname,shopee_shop_id,pedidos,vendas}], por_status:[{status,pedidos,vendas}]}`. Lê `orders` de `marketplace_id=SHOPEE`, janela por `date_created` no fuso SP |
| `GET /api/shopee/chat?store_id&todas` | conversas Shopee (`shopee_chat`) — `{rows:[{conversation_id,buyer_name,unread_count,last_message,last_message_type,last_message_ms,conta}], resumo:{conversas,nao_lidas}}`. Por padrão só `unread_count>0`; `todas=1` inclui as já respondidas. Preenchido pelo job `syncShopeeChat` (worker) |
| `GET /api/shopee/chat/:conversationId/mensagens` | histórico de uma conversa, buscado ao vivo na Shopee (`get_message_list`) — `{buyer_name, rows:[{message_id, de:'comprador'\|'loja', tipo, texto, ts_ms}]}` (ordem cronológica). Resolve a loja dona da conversa e renova token com CAS (`getShopeeClientForStore`) |
| `POST /api/shopee/chat/responder` `{conversation_id,text}` | responde o cliente **dentro da plataforma** (`send_message`) usando o `to_id` guardado em `shopee_chat` (v38); zera `unread_count` local. Pode exigir "Acesso a dados sensíveis" aprovado — erro de negócio da Shopee é repassado no `error` |
| `GET /api/shopee/financeiro?store_id&dias` | financeiro/repasse (escrow) Shopee — **isolado da Conciliação Bancária do ML**. Por pedido: `buyer_total` (bruto), `commission_fee` (taxa Shopee), `escrow_amount` (**líquido**), `buyer_payment_method`, `logistics_status` (entrega), `tracking_number`. `{rows:[...500], resumo:{bruto,comissao,liquido,com_escrow,dias}}`. Lê `shopee_order_data` (preenchido pelo worker via `get_escrow_detail`/`get_tracking_info`; backfill: `server/backfill-shopee-financeiro.js`) |
| `GET /api/shopee/anuncios?store_id&status` | catálogo Shopee (`items` + LEFT JOIN `shopee_item_data`, `marketplace_id=SHOPEE`) com filtro por loja/status — `{rows:[{item_id,sku,title,estoque,vendidos,price,status,thumbnail,category_id,conta,has_model,variation_count,price_min,price_max}], resumo:{total,ativos,pausados,estoque_total}, note}`. Preenchido pelo job `syncShopeeCatalog` (v39); `note` só aparece se ainda não sincronizou |

## Alertas
| Rota | Descrição |
|---|---|
| `GET /api/alertas/reposicao?threshold&store_id` | itens com estoque ≤ threshold (padrão 15), com resumo por faixa (zero/critical≤3/low≤10/medium) |
| `GET /api/alertas/cancelamentos` | últimos 100 pedidos cancelados |
| `GET /api/alertas/devolucoes?store_id&q&date_from&date_to` | devoluções + summary por status. `date_from`/`date_to` filtram por `returns.date` — usados pelos botões de atalho Hoje/Ontem/7/15/30 dias em `pages/devolucoes.html`. **Uma linha por reclamação** (v59: `returns` deduplicado por `claim_id`, ver `database.md`). Cada linha inclui `reason_detail` (motivo traduzido, `claim_reasons` join com fallback pro código cru), `claim_id` (nº da reclamação = coluna `returns.claim_id` real, com fallback pro `raw_data->>'id'` — coluna "Nº Reclamação", filtrável e mostrada no modal), `stage`/`type`/`substatus`/`last_updated`/`last_synced_at` (coluna + extraídos de `returns.raw_data`), `raw_data` completo (JSON bruto da claim, pro modal de detalhe mostrar "tudo"), `prejuizo` (valor manual, `null` se não lançado), e o produto/pedido associado via `LEFT JOIN vw_ml_orders`/`vw_ml_items` (`item_id`, `item_title`, `item_thumbnail`, `item_permalink`, `order_quantity`, `order_amount`, `shipping_type`, `order_date`) — `order_amount` é o valor real a mostrar como "Valor da devolução" (`returns.amount` também é preenchido com o mesmo valor desde a correção de `resolveReturnAmount()`, ver `decisions.md`). `summary` inclui `prejuizo_total` (soma de `prejuizo` das linhas com valor lançado, dentro do filtro atual), `prejuizo_qtd` (quantas linhas têm prejuízo lançado), `pedidos_total`/`taxa_devolucao_pct` (ver acima), `ranking_produtos` (top 10 itens por nº de devoluções no período, com `item_id`/`conta` (loja) já inclusos junto de `pedidos`/`taxa_pct` do próprio item — só busca pedidos dos `item_id` que aparecem nas devoluções, não o catálogo inteiro), `taxa_por_loja` (array por `store_id`, devoluções/pedidos/taxa — pra comparar contas lado a lado quando `store_id` não é informado) e `pedidos_por_logistica` (array `{shipping_type, pedidos}` com o valor cru de `orders.shipping_type`; o bucket Flex/Mercado Envios/Full é feito no frontend com `logLabel()`, mesma função já usada na tabela — ver `business-rules.md` e `decisions.md`) |
| `PATCH /api/alertas/devolucoes/:id/note { note }` | anotação manual em uma devolução |
| `PATCH /api/alertas/devolucoes/:id/prejuizo { prejuizo }` | valor de prejuízo digitado manualmente (R$) — string vazia/inválida grava `NULL` (não lançado), não zero |
| `PATCH /api/alertas/devolucoes/:id/abertura-chamado { abertura_chamado }` | flag manual "Abrir chamado" (v43) — checkbox na tabela de Devoluções; sai como Sim/Não no CSV/PDF |
| `POST /api/alertas/devolucoes/:id/atualizar-status` | reconsulta **só esta** claim no ML (`ml.getClaim`, 1 GET — evita rate limit) e faz **upsert por `claim_id`** via `claims.js` (nunca cria linha nova; grava a transição em `claim_history`). Ação pontual (mlClient chamado da rota, exceção documentada). Retorna `{ok,status,substatus,stage,type}`. 429 → mensagem amigável |
| `GET /api/alertas/devolucoes/:id/historico` | v59: timeline da reclamação — todos os eventos de `claim_history` do `claim_id` desta devolução, ordenados por data. `{claim_id, eventos:[{event_type,status,substatus,description,created_at}]}`. Alimenta o modal "Histórico" na página de Devoluções |
| `POST /api/schedule/jobs/syncClaimsStatus/trigger` | dispara no worker (`worker:cmd`) o job `syncClaimsStatus` — reconsulta em 2º plano todas as devoluções pendentes (status opened/analysis), 1 por vez espaçada (respeita rate limit). Avisa no WS (`devolucoes_sync_start`/`devolucoes_sync_done`) e Telegram |
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
| `GET /api/dashboard/glance` | **Visão rápida** do Dashboard (celular), 1 chamada (`Promise.all`): `{afazer:{enviar,perguntas,mensagens,devolucoes}, alertas:{ruptura,zerados,backup_due}, top:[{title,qtd,receita} ×3]}`. `enviar`=pedidos com `shipping_status` a despachar; `devolucoes`=reclamações não fechadas/resolvidas; `ruptura`=itens de `getRupturaEstoque(7d)`; `zerados`=itens ativos com estoque 0; `backup_due` de `backup.getStatus()`; `top`=3 mais vendidos hoje (unidades). Tudo ML |
| `GET /api/sistema/backup` | status do backup pro sino do topbar: `{last:{ts,ok,file,size,error}, files:[{name,size,mtime}], due, retention_days}`. `due`=nunca fez / último falhou / +26h. Ver `backup.js`/`workers.md` |
| `POST /api/sistema/backup/run` | dispara um backup **manual** agora (pg_dump inline no processo do server); retorna o status. Trava anti-duplo-clique |
| `GET /api/sistema/backup/:file/download` | baixa um `.sql.gz` (nome validado por regex anti path-traversal; arquivos ficam fora da pasta servida, download só aqui atrás do gate de auth) |
| `GET /api/sistema/saude` | **Saúde do Sistema** (`health.js`): `{filas, ultimo_webhook, syncs, processos:{worker,server:{up,down,last_beat,boots_10min,restart_loop}}, servidor:{hostname,platform,node,cpu:{load_pct,cores,load1},mem:{used_pct,total,free},disk:{used_pct,total,free}|null,uptime_server_s,uptime_process_s}, limites, ts}`. Só leitura (Redis + `webhook_logs` + `schedule_jobs`). O sinal de webhook empilhando é `filas.backlog` (BullMQ) — `webhook_logs pending` NÃO é usado (log deduplicado acumula `pending`, ver `decisions.md`). Página `saude-sistema.html`; alertas `tg_saude` disparados pelo worker. Ver `workers.md` |

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
| `POST /webhooks/shopee` | webhook Shopee ("Mecanismo de Empurra") — **isolado do gateway ML** (`routes/shopeeWebhook.js`, montado antes do `express.json()` pra ter o corpo cru). Valida assinatura HMAC (`push_url\|body`, header Authorization), responde 200 e enfileira o mesmo evento do polling (`marketplace-events-shopee`) → tempo real. `SHOPEE_WEBHOOK_VERIFY=false` desliga a validação pro 1º teste. `GET /webhooks/shopee` responde 200 (teste de conectividade do console) |
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
| `GET /api/embalagem/pedido/:shippingId` | **estação única ML+Shopee**. Tenta primeiro `orders.shipping_id` (ML) — pode retornar mais de 1 (envio/pack); se não achar, casa por `shopee_order_data.tracking_number` (a etiqueta Shopee traz o rastreio `BR…` no QR, não o nº do pedido) e expande o `item_list` do `raw_data` em cards no mesmo shape. Campos: `thumbnail` (ML: `items`; Shopee: `item_list[].image_info.image_url`), `title`/`quantity`/`buyer_nickname`/`store_nickname`, `unit_price`/`status`/`shipping_type`/`date_created`/`available_quantity`/`seller_sku`/`variation_attributes` — tudo do Postgres, sem chamar API. Resposta inclui `marketplace` (`'ML'`\|`'SHOPEE'`) e `already_packed` (`{id, created_at}` do vídeo mais recente pra essa etiqueta, ou `null`). No Shopee o comprador vem `null` (dado sensível — app sem acesso) |
| `POST /api/embalagem/finalizar` (multipart: `video`, `shipping_id`, `order_ids` (JSON), `duration_seconds`, `store_id`) | salva o vídeo gravado em `server/storage/embalagem-videos/YYYY-MM-DD/` e grava a linha em `packing_videos` |
| `GET /api/embalagem/videos?order_id&buyer&date_from&date_to&store_id&marketplace` | busca vídeos salvos (abas "Buscar vídeos" e "Conferência do Dia" — a segunda sempre fixa `date_from`/`date_to` no dia corrente); cada linha inclui `sample_shipping_type` (do 1º pedido do envio) — usado pelos cards de resumo Flex/Mercado Envios/por loja na aba Conferência do Dia |
| `GET /api/embalagem/por-hora?date=YYYY-MM-DD&store_id` | quantidade de bipagens por hora (0-23, zero-fill) num dia — usado pelo gráfico de colunas "dia selecionado vs. dia anterior" da aba Conferência do Dia |
| `GET /api/embalagem/videos-por-pedidos?order_ids=1,2,3` | lookup em lote (1 chamada, não N+1) — devolve `{order_id: {id, created_at}}` só pros pedidos que têm vídeo. Usado pelo botão "Assistir" na tela de Devoluções (`pages/devolucoes.html`) |
| `GET /api/embalagem/historico?days=30&store_id` | série diária zero-fill (`days` entre 1-90, default 30) — `count` (bipagens no dia) e `duration_sum`/`duration_orders` (pra calcular tempo médio/pedido no frontend, mesmo padrão SUM/SUM do card da Conferência do Dia). Usado pela aba Histórico |
| `GET /api/embalagem/videos/:id/file` | stream do arquivo de vídeo (`res.sendFile`, suporta `Range` — necessário pro player HTML5 avançar/voltar) |
| `GET /api/embalagem/erros?days` | **Relatório de erros de embalagem** (v65): falhas ao salvar o vídeo (`embalagem_errors`) — `{errors:[{error_type, shipping_id, order_ids, store_nickname, staff_user_name, detail, created_at}]}`, aba "Erros" na página. O `POST /finalizar` registra aqui em qualquer falha (upload/disco/limite/insert) via `logEmbalagemError`. Ver `embalagem.md` |
| `GET /api/embalagem/auditoria?only_printed&only_missing&days&date_from&date_to&search` | **Aba Auditoria — "expedição do dia"**: filtro de período pela **data da venda** (`date_created` em SP) — `days` (últimos N, ex. 3/5/10/15/21/30) OU `date_from`/`date_to` (personalizado); sem nada = tudo. **`search`** (nº do pedido / `shipping_id` / rastreio, `ILIKE`) faz busca direta e **ignora status/logística/período** — pra checar se um pedido específico foi ou não bipado, mesmo já expedido. pedidos que precisam sair (ML FLEX/Mercado Envios com `shipping_status='ready_to_ship'`; Shopee Entrega Rápida/Agência com `order_status` READY_TO_SHIP/PROCESSED) cruzados com `packing_videos` → `{items:[{order_id, title, store_nickname, marketplace, logistica, printed, bipado, date_created, etiqueta_impressa_at}], resumo:{total, bipados, faltando, por_logistica}}`. Base no **status de envio**, não na data (decisão do usuário — corte por horário descartado). `etiqueta_impressa_at` vem de `print_jobs.printed_at` (data/hora real da impressão). Filtros `only_missing`/`only_printed`. Ver `embalagem.md` |
| `POST /api/embalagem/print-label` (`{shipping_id, product_name, variation_type, sku, company_name}`) | imprime rótulo térmico (10x15 cm) em impressora de rede com QR code, produto, data/hora e texto "PRODUTO EMBALADO PELA EMPRESA [company_name]". Chamada automaticamente após upload de vídeo. Se `THERMAL_PRINTER_IP` não configurado, retorna silenciosamente `{ok:false, reason:'printer_not_configured'}` (útil em teste). Ver `embalagem.md` ("Impressora térmica — rótulo pós-embalagem") |

## Conciliação Bancária (`routes/api.js`, ver `conciliacao-bancaria.md`)

| Rota | Descrição |
|---|---|
| `GET /api/conciliacao/resumo-lojas` | total a receber (`released != 'yes'`) agrupado por loja — só devolve lojas com ≥1 pagamento pendente (`HAVING`). Usado pelos cards por loja, que só aparecem na tela quando há 2+ lojas com pendência (1 loja só já é redundante com o card "Total Pendente") |
| `POST /api/conciliacao/pagamentos/:paymentId/reprocessar` | ação pontual (botão "Reprocessar" no modal, não leitura de listagem — `mlClient` importado localmente na rota, mesmo padrão de "responder pergunta", ver `architecture.md` regra 2) — refaz o `UPDATE` de `sync-payment-releases` (pagamento via `/collections/:id`) **e** o de `sync-shipping-status` (entrega via `/shipments/:id`, se o pedido tem `shipping_id`), sob demanda pra 1 pedido só. Como é 1 pedido (não 200), não esbarra no rate limit em lote do "Sincronizar Entregas". A consulta de entrega é isolada em try/catch: se falhar (ex: 429), o reprocesso do pagamento já foi persistido e a resposta traz `{ok:true, shipping_error:'...'}` pro modal avisar |
| `GET /api/conciliacao/agenda-recebimentos?store_id` | agrupa `ml_payments` com `released != 'yes'` por dia de `money_release_date` (fuso São Paulo) — `{dias: [{data, qtd_pagamentos, valor_liquido, valor_bruto}]}`. Granularidade diária; agregação "hoje/amanhã/7 dias/30 dias" é feita no cliente, não pré-calculada aqui |
| `GET /api/conciliacao/extrato?store_id&date_from&date_to&tipo&q&page&limit&all` | extrato da conta MP (`mp_account_movements`, fase 2) — cada crédito/débito paginado. `tipo` filtra por `description` (Payment/Cash withdrawal/Refund/Shipping fee/...). Exclui linhas `record_type='Total'`. `all=1` ignora a paginação e devolve o conjunto filtrado inteiro (teto de segurança 100k linhas) — usado pelo export CSV "conforme filtro". `{movimentos, total, page, limit}` |
| `GET /api/conciliacao/saques?store_id&date_from&date_to` | lista os movimentos `description='Cash withdrawal'` (transferências pro banco). `date_from`/`date_to` filtram `release_date` no fuso São Paulo. `{saques: [{release_date, valor, balance, store_nickname}]}` |
| `GET /api/conciliacao/auto?store_id&verdict` | conciliação automática: por pagamento, compara `net_received_amount` (esperado) com `SUM(net_credit_amount)` dos movimentos daquele `source_id` (recebido no extrato). Veredito em JS (tolerância R$ 0,50): `conciliado`/`diferenca`/`pendente`/`estornado`. `{pagamentos: [...500], resumo: {conciliado, diferenca, ...contagens}, total}` |
| `GET /api/conciliacao/prazo?store_id&base&date_from&date_to` | prazo de recebimento — mede a média de dias entre a **venda** (`date_approved`) e o **dinheiro cair na conta** (`money_release_date`), só de pagamentos já liberados (`released='yes'` e ambas as datas não-nulas). `dias = EXTRACT(EPOCH FROM (money_release_date - date_approved))/86400`. `base` ∈ `venda` (default, filtra `date_approved::date`) \| `recebimento` (filtra `money_release_date` no fuso São Paulo) — escolhe **sobre qual data** `date_from`/`date_to` agem (whitelist, nunca interpola a coluna direto). `JOIN orders` pra trazer `shipping_type` (logística) e `stores` pro nickname. `{prazos: [...500 linhas {order_id, store_nickname, shipping_type, data_venda, data_recebimento, valor_venda, valor_recebido, dias}], resumo: {qtd, media_dias, total_venda, total_recebido, por_logistica: {full\|flex\|me\|coleta\|outros: {qtd, media_dias}}}}` — a média por logística usa o helper `logisticaBucket()` (mesmo mapeamento por substring de `LOGISTICA_BUCKETS`) |
| `GET /api/conciliacao/pagamentos/:paymentId` | 1 pagamento completo (`SELECT p.*` + `buyer_nickname`/`title`/`order_total_amount`/`item_id`/`store_nickname`/`shipping_status`/`shipping_substatus`/`date_ready_to_ship`/`date_shipped`/`date_delivered`/`shipping_last_updated` via JOIN) — usado pelo modal de detalhe da grid, inclui `raw_data` (payload bruto de `/collections/:id`) pra auditoria |
| `GET /api/conciliacao/pagamentos?store_id&released&date_from&date_to&q&entrega&logistica&release_from&release_to&sort&dir&page&limit` | grid paginada (`LIMIT`/`OFFSET` reais, `COUNT(*)` separado sobre todo o range filtrado — mesmo padrão do fix de `vendas/detalhado`) — `JOIN orders`/`stores` pra trazer `buyer_nickname`/`title`/`store_nickname`/`shipping_status`/`shipping_substatus`/`date_ready_to_ship`/`date_shipped`/`date_delivered`/`shipping_last_updated`/`shipping_type` (v33; `shipping_type` é a logística — Full/Flex/Mercado Envios/Coleta, mesmo mapeamento de `fmtLogistica` em `worker.js`). `logistica` ∈ `full`\|`flex`\|`me`\|`coleta`, traduzido server-side pra padrões `ILIKE ANY` via `LOGISTICA_BUCKETS` (`shipping_type` não tem conjunto fechado de valores exatos, filtra por substring — mesmo motivo de `fmtLogistica` usar `.includes()`). `date_from`/`date_to` filtram por `date_approved::date`. `q` busca em `order_id`/`payment_id`/`buyer_nickname` (ILIKE). `entrega` ∈ `aguardando`\|`preparando`\|`transito`\|`entregue`\|`cancelado`\|`nao_entregue` (bucket de UI, traduzido server-side pra lista de status crus via `SHIPPING_STATUS_BUCKETS` — ver `business-rules.md` pro mapeamento completo). `release_from`/`release_to` filtram por `money_release_date` no fuso São Paulo (mesmo cast da Agenda de Recebimentos) — usado pelo drill-down dos cards "Recebo Hoje/Amanhã/7 dias/30 dias", que ao clicar filtram a grid pelas vendas que caem naquele intervalo (com `released=no`, pra bater com o número do card). `sort` ∈ `data`\|`valor`\|`liquido`\|`status`\|`diferenca`\|`liberacao`\|`entrega` (whitelist, nunca interpola direto). `taxas` = soma de `marketplace_fee+mercadopago_fee+discount_fee+coupon_fee+finance_fee` (sub-estima o custo real — ver `diferenca`). `diferenca` = `transaction_amount - net_received_amount` (fallback 0 se `net_received_amount` ainda nulo) — é o valor exibido na tela como "taxa da venda" de fato, mais confiável que `taxas` porque os 5 campos de taxa do Mercado Pago costumam vir zerados mesmo quando o valor líquido é bem menor que o bruto (a comissão do Mercado Livre em si não está detalhada em nenhum desses campos). `{payments: [...], total, page, limit}` |

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

## Print Agent (`/api/print/*` staff, `/print-agent/*` agente)

Ver `.claude/print-agent.md`. As rotas do agente ficam **antes** do gate de staff (auth por token de estação no header `X-Station-Token`).

**Gestão (staff, `/api/print`):**
- `POST /api/print/jobs` — enfileira impressão. Body `{shipping_id, station_id?|store_id?, label:{product_name,variation_type,sku,store_name,company_name}}`. Publica WS `print:{station_id}`. 409 se a loja não tem estação.
- `GET /api/print/jobs?status=&station_id=&limit=` — monitorar a fila.
- `POST /api/print/stations` — cadastra estação, devolve o `token` (1x). Body `{name, store_id?, printer_name?}`.
- `GET /api/print/stations` — lista (token mascarado).

**Agente (`/print-agent`, token de estação):**
- `GET /print-agent/jobs/next` — reivindica 1 job atômico (FOR UPDATE SKIP LOCKED).
- `GET /print-agent/jobs/:id/pdf` — PDF 10×15 regerado de `label`.
- `POST /print-agent/jobs/:id/confirm` | `.../error` — confirma/reagenda (retry até 3x).

## Análise de Produtos (`/api/analise`, staff)

Ver `.claude/analise-produtos.md`. `routes/analise.js`:
- `GET /api/analise/produtos` → `{rows, ativo_id}` (com `anuncios_count`).
- `GET /api/analise/produtos/:id` → `{produto, anuncios, ativo_id}` (anúncios com `full`/`flex` aliasados de `is_full`/`is_flex`).
- `POST /api/analise/produtos` → cadastrar. `POST /api/analise/produtos/:id/editar` → editar.
- `POST /api/analise/produtos/:id/ativar` → define único produto ativo de coleta. `.../finalizar` → limpa.
- `POST /api/analise/produtos/:id/analisar` → **motor de IA (Fase 3 núcleo)**: Score + Comentários + Financeiro + Decisão. Grava `ai_result`/`ai_score`/`ai_analyzed_at` e devolve `{result, score, produto}`. Síncrono. `503` sem `ANTHROPIC_API_KEY`, `400` sem concorrentes.
- `POST /api/analise/produtos/:id/criativos` → gera **7 briefs de imagem (JSON)** que quebram objeções dos comentários (pro ChatGPT). Grava `ai_creativos`/`ai_creativos_at`, devolve `{criativos:[7]}`. On-demand (mais caro). `503` sem chave.
- `GET /api/analise/ia/gastos` → gasto real da IA (hoje/mês/total/média por análise, via `ai_usage_log` = tokens×preço) + estimativa de saldo (`restante`/`est_analises`/`est_dias`) a partir do saldo informado.
- `POST /api/analise/ia/saldo` `{saldo_usd}` → registra o saldo atual (a Anthropic não expõe saldo pela API; base da estimativa).
- `POST /api/analise/produtos/:id/monitorar-agora` → snapshot AGORA de cada MLB do produto (preço/estoque/vendas/visitas via API do ML) → `{ok, fail, total}`. O job diário `sync-monitor-analise` faz isso sozinho. `GET /produtos/:id` devolve `anuncio.monitor = {historico, ultimo, count, alertas}` — `alertas` (v60) são as últimas 20 mudanças detectadas do MLB (preço/estoque/status/vendas), com `alert_type`/`old_value`/`new_value`/`delta_pct`/`message`/`created_at`. O disparo do alerta (Telegram + gravação) acontece dentro de `recordSnapshot`, não numa rota. Ver `analise-produtos.md`.

Anúncios (`analise_product_ads`) agora têm `link` e `ml_id` (MLB) editáveis — o `POST /anuncios/:adId/editar` e o add manual aceitam ambos; o MLB é extraído do link se faltar.
- `POST /api/analise/anuncios/:adId/atualizar-ml` → **GET completo do MLB** (`monitor.getAdDataFromMl`: `/items/{MLB}` + `/users/{seller}` + `/reviews/item` + `/questions/search`) e preenche os campos do card (título, preço, fotos, vendedor, reputação, cidade/estado, nota, comentários, perguntas, FULL/FLEX) via COALESCE (não apaga o manual) + grava um snapshot. Devolve o anúncio (`mapAd`) já com `.monitor`. Botão azul no topo do card. `400` sem MLB, `503` sem loja ML.
- WS `analise_anuncio` `{produto_id, anuncio}` — card ao vivo quando a extensão salva (publicado no passo da extensão).

Extensão (público, `routes/extensionAnalise.js`, montado em `/extension` antes do gate): `GET /extension/produto-ativo`, `POST /extension/anuncio`, `GET /extension/monitor/:mlb` (histórico de preço do MLB pro mini-gráfico do painel — `{historico, delta30d, count}`, read-only).

**Devoluções — situação/estágio manual (v63):**
- `POST /alertas/devolucoes/:id/situacao` `{situacao, label}` → grava `returns.situacao` e registra um evento na timeline (`claim_history`, `event_type='situacao'`). Situação vazia limpa a etiqueta.
- `GET /alertas/devolucoes/situacoes` → `{custom:[{key,label,icon,color}]}` (estágios customizados, guardados em `app_config.devolucao_situacoes`).
- `POST /alertas/devolucoes/situacoes` `{label,icon?,color?}` → adiciona um estágio customizado. A listagem `GET /alertas/devolucoes` passou a devolver `r.situacao`.
- Destaque de linha (só frontend, `pages/devolucoes.html`): linha **sem estágio OU sem observação** fica com destaque amarelo (`dev-pendente`); linha com **status `closed`** (selo "Encerrada", do ML) **ou** estágio manual **`resolvido`** fica **verde claro** (`dev-resolvido`); estágios de **"Acompanhar"** (`mediacao`/`devolucao`) deixam a linha **vermelha** (`dev-acompanhar`). Prioridade: verde > vermelho > amarelo.
