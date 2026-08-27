# Regras de Negócio

> Escopo: comportamento de domínio que não é óbvio olhando só a assinatura de uma função — thresholds, definições, e por que o sistema decide X e não Y. Regras puramente financeiras (fórmula de margem, ROI) estão em `finance.md` para não duplicar. **Sempre que uma nova regra de negócio for descoberta ou definida, registre aqui.**

## Análise de Vendas do Mês — fórmulas dos insights (`GET /api/analises/vendas-mes`)

**Sem normalização por dia útil** — decisão explícita do usuário: todo dia do mês conta igual nas comparações (não pondera por quantos dias úteis cada mês teve). Ver `decisions.md`.

- **Dia "ocorrido" vs. futuro**: se o mês selecionado é o mês corrente, dias após hoje ficam com `receita`/`pedidos`/`ticket_medio` = `null` e `ocorrido: false` — nunca contam como "zero vendas" nos KPIs, rankings ou insights.
- **Crescimento vs. mês anterior**: compara receita acumulada do mês atual (só dias já ocorridos) com a receita do mês anterior **no mesmo número de dias** (não o mês anterior inteiro) — comparação justa entre períodos de tamanho igual.
- **Média histórica por dia-do-mês**: média (e desvio-padrão populacional) da receita de cada dia-do-mês (1..31) ao longo dos 12 meses **anteriores ao mês selecionado** (janela móvel, não fixa em "últimos 12 meses a partir de hoje") — evita que o próprio mês analisado contamine sua baseline.
- **Banda estatística**: `banda_min = max(0, média − desvio)`, `banda_max = média + desvio` — 1 desvio-padrão, não 2 (não é Bollinger Band clássico de trading).
- **Tendência**: regressão linear simples (mínimos quadrados) sobre os pares (dia, receita) dos dias já ocorridos do mês. `direcao` = "alta" se `|slope| ≥ 1`, senão "estável"/"queda".
- **Índice de aceleração**: divide os dias já ocorridos em duas metades; calcula a taxa média de crescimento dia-a-dia (%) de cada metade; `aceleração = taxa(2ª metade) − taxa(1ª metade)`. Positivo = vendas crescendo mais rápido na 2ª metade do período; negativo = desacelerando.
- **Melhor/pior semana**: blocos fixos de 7 dias corridos dentro do mês (dias 1-7, 8-14, ...) — não é semana ISO (segunda-domingo), é só um agrupamento simples pra achar o bloco de 7 dias com mais/menos receita.
- **Concentração top 5**: % da receita acumulada do mês que veio só dos 5 dias de maior faturamento — sinaliza dependência de poucos picos (ex: dias de promoção) vs. distribuição mais uniforme.
- **Acumulado**: soma corrida da receita dia a dia; compara o valor acumulado do mês atual com o acumulado do mês anterior no mesmo dia-do-mês (não o total do mês anterior).
- **Projeção de fechamento**: `receita_acumulada + Σ(dias restantes) de max(0, intercept + slope × dia)` — usa a reta de regressão do item "tendência" para projetar cada dia que falta, não uma simples extrapolação linear de "média diária × dias restantes".
- **Sugestão de reposição de estoque**: top 5 itens por unidades vendidas no mês, cruzado com `items.available_quantity` — só entra na sugestão quem tem estoque ≤ 15 (mesmo threshold "medium" já usado em `GET /api/alertas/reposicao`, ver seção "Estoque" acima — reaproveitado, não uma constante nova).
- **Sugestão de reforço de anúncios**: os 5 dias de menor faturamento do mês (`ranking_bottom10`, top 5) — heurística simples, não analisa causa (não distingue "dia fraco por sazonalidade" de "dia fraco por falta de anúncio ativo").
- **Filtro por anúncio (`item_id`)**: opcional, filtra `mes_atual`/`mes_anterior`/`mes_retrasado`/`media_historica` por `orders.item_id`. Combina com `store_id` (AND, não OR). Não filtra `dia_ideal`/`sazonalidade` de forma diferente — eles usam a mesma `media_historica` já filtrada.

## Dia Ideal — comparação do dia corrente com a média histórica

`dia_ideal` (dentro do payload de `GET /api/analises/vendas-mes`) só é calculado quando o `year`/`month` consultado é o mês corrente real (`hoje.getFullYear()`/`hoje.getMonth()+1`) — em qualquer outro mês (histórico ou futuro) o campo vem `null`, porque "dia ideal" só faz sentido comparando o dia de hoje com o esperado, não um dia de um mês já fechado.

- **Esperado**: `media_historica` do dia-do-mês atual (mesma base de 12 meses anteriores usada nos outros gráficos — **sem normalização por dia útil**, mesma decisão da seção acima, reconfirmada explicitamente pelo usuário para esta feature).
- Só calcula se houver pelo menos 1 mês de histórico para aquele dia (`meses_analisados > 0`) — evita mostrar "esperado: R$ 0" para dia 29/30/31 em meses com pouco histórico.
- **Status por `diferenca_pct`**: `≥ 20%` → `muito_acima`; `≥ 5%` → `acima`; `≥ -5%` → `dentro_da_media`; `≥ -20%` → `abaixo`; `< -20%` → `muito_abaixo`. Os mesmos limiares alimentam as 5 zonas coloridas do gauge no frontend.
- **Insight automático**: além do texto de "X% acima/abaixo da média", quando o dia atual está entre os top/bottom 20% históricos (`ranking` em `media_historica`), acrescenta contexto — "este é um dos dias mais fortes/fracos do mês historicamente".
- **`esperado` é o dia INTEIRO, `atual` é só o PARCIAL de hoje até agora** — comparação estruturalmente desbalanceada (um total fechado contra um total ainda em andamento), então o card deixa isso explícito em vez de deixar parecer "abaixo da meta": badge no topo com `pct_dia_decorrido`/`hora_atual` ("Dia em andamento — X% decorrido, faltam Yh"), labels dos campos anotados ("dia inteiro" vs. "parcial, até HH:MM") e o texto do insight menciona que o dia ainda não fechou, apontando pro Termômetro por Horário (comparação já normalizada pelo mesmo ponto do dia) logo abaixo como leitura mais justa de "como estou indo agora". Pedido explícito do usuário, depois de ver o card e achar que dava a entender que já estava perdendo a meta do dia.

## Termômetro por Horário — duas comparações complementares ao Dia Ideal

`termometro_horario` (mesmo payload de `GET /api/analises/vendas-mes`, mesma condição de só existir no mês corrente real) responde uma pergunta diferente do Dia Ideal: não "como fechou o dia comparado à média histórica" (só sabido no fim do dia), mas "como estou indo **agora**, neste exato horário, comparado ao mesmo ponto do dia em outras referências". Pedido explícito do usuário — duas comparações lado a lado, mesmo padrão visual de gauge/termômetro do Dia Ideal:

- **Média dos últimos 30 dias, até o mesmo horário**: para cada um dos últimos 30 dias (hoje excluído), soma a receita daquele dia até o mesmo horário:minuto de agora, depois tira a média dessas 30 somas. Não é "vendas feitas *dentro* desta hora" (métrica muito ruidosa, hora a hora varia demais) — é receita **acumulada desde 00:00** até o horário atual, a mesma lógica de "pacing" do dia.
- **Ontem, até o mesmo horário**: mesma soma acumulada de 00:00 até o horário atual, só que o dia de referência é ontem (1 dia), não uma média de 30.
- **Corte por horário:minuto exato** (`EXTRACT(HOUR...)*60 + EXTRACT(MINUTE...)`), não por hora cheia arredondada — comparação apples-to-apples com o instante exato de "agora", sem viés de arredondar pra cima ou pra baixo.
- **Status e limiares idênticos ao Dia Ideal** (`≥20%`→`muito_acima`, `≥5%`→`acima`, `≥-5%`→`dentro_da_media`, `≥-20%`→`abaixo`, `<-20%`→`muito_abaixo` — função `statusDeDiferenca()` compartilhada entre as duas features, ver `decisions.md`).
- Diferente do Dia Ideal, não exige histórico de 12 meses — só 30 dias corridos, então fica disponível bem antes do Dia Ideal ter dado histórico suficiente pra um dia-do-mês específico.

## Calendário de Sazonalidade — estrelas, ranking e participação

Calculado em cima da mesma `media_historica` (12 meses anteriores, por dia-do-mês) já usada pelo resto da página — não é uma nova consulta, é uma segunda leitura dos mesmos dados agregados.

- **Estrelas por percentil** (não por valor absoluto): os dias são ordenados por receita média histórica e divididos em quintis — top 20% = 5 estrelas, próximos 20% = 4, ..., bottom 20% = 1 estrela. Dinâmico por loja/item filtrado — os mesmos 5 pontos de corte não são reaproveitados entre filtros diferentes.
- **Participação %**: `media do dia / soma das médias de todos os dias do mês × 100` — "quanto desse dia representa dentro de um mês histórico médio", não participação no mês real selecionado.
- **Lucro médio por dia histórico**: usa a mesma fórmula de margem de `finance.md` (`total_amount − custo − imposto − ml_fee − shipping_cost − shipping_seller_cost`), agregada por dia-do-mês nos mesmos 12 meses — não é recalculada com fórmula diferente da usada em `GET /api/vendas/detalhado`/relatório semanal por e-mail.
- **Escopo deliberadamente reduzido**: a Calendário de Sazonalidade **não inclui Conversão nem ROAS** por dia — Conversão exigiria profundidade histórica de `item_visits` que o sync só passou a coletar de forma confiável nesta mesma sessão (sem 12 meses de histórico ainda); ROAS exigiria gasto de anúncio por dia, que o sistema não rastreia granularmente. Decisão consciente de não mostrar um número que pareça preciso mas seja baseado em dado insuficiente (ver `decisions.md`).
- **Sem filtro de marketplace/categoria**: a página é ML-only (Amazon tem páginas isoladas, ver `decisions.md`/`amazon.md`) e não existe campo "categoria" sincronizado nos itens — os únicos filtros são loja (`store_id`) e anúncio (`item_id`).
- **Drawer de drill-down** (`GET /api/analises/vendas-mes/dia-historico`): ao clicar num dia do calendário, mostra a evolução desse dia-do-mês ano a ano (últimos 12 meses) e os produtos mais vendidos nesse dia-do-mês — granularidade "esse dia do mês ao longo do tempo", diferente do modal do heatmap principal (`GET /api/analises/vendas-mes/dia`), que mostra os pedidos de uma data específica (`YYYY-MM-DD`) só do mês selecionado.

## Alerta de outlier estatístico (`checkOutlierEstatistico`)

Job diário (06:20, ver `workers.md`) que compara a receita de **ontem** de cada loja ML com a média histórica do mesmo dia-do-mês (mesma janela de 12 meses da página BI, recalculada em JS dentro do worker, sem chamar a própria API HTTP).

- **Limiar de disparo**: `±1.5 desvio-padrão` da média histórica — mais rígido que a banda visual do Chart 2 da página BI (`±1` desvio, ver acima), porque o alerta de Telegram precisa de menos ruído/falsos positivos do que um gráfico exploratório.
- Só dispara se houver `≥ 3` meses de histórico para aquele dia-do-mês (`n < 3` → ignora, sem alertar) — evita alertar com base estatística fraca.
- Respeita janela de silêncio e pode ser desligado por tópico (`tg_outlier`) — **não** usa `tgNotifyForce`, é tratado como alerta, não como relatório operacional (mesma categoria de `tg_topvendas`).

## Alerta do Dia (`GET /api/dashboard/alertas-dia`, `pages/top-vendas-online.html`)

Card que consolida dois sinais já calculados em outro lugar (nenhuma fórmula nova):
- **Outliers de loja**: reaproveita `getOutliersOntem()` — mesmo cálculo/limiar (±1.5 desvio-padrão) do alerta Telegram `tg_outlier` (ver seção "Alerta de outlier estatístico" acima).
- **Estoque crítico entre os mais vendidos**: cruza os itens mais vendidos (unidades) nas últimas 24h com `available_quantity <= 15` — mesmo threshold "medium" já usado em `GET /api/alertas/reposicao` (ver seção "Estoque" acima), reaproveitado, não uma constante nova. Objetivo: destacar item que "vendeu bem e pode faltar", não estoque baixo em geral (isso já existe na página de Reposição).
- Se nenhum dos dois disparar, mostra estado vazio positivo ("nenhum alerta hoje") — nunca mostra "sem dados" como se fosse erro.

## Agenda Trello — regras de geração automática de cartão

Ver `task-engine.md` para a arquitetura do `TaskEngine`. Regras de negócio das duas geradas hoje (só Mercado Livre):

- **Estoque crítico** (`rule_key='estoque_critico'`): mesmo limiar `available_quantity <= 5` já usado no alerta Telegram `tg_reposicao` (`handleItem`, ver "Estoque — thresholds diferentes por contexto" acima) — não é um 4º threshold novo, é o mesmo sinal virando cartão. Prioridade `alta`.
- **Score de qualidade baixo** (`rule_key='score_baixo'`): dispara quando `score < 50` no resultado de `/item/:id/performance` (mesmo dado gravado em `item_performance` pelo job `syncScores`, 01:00 diário — ver `workers.md`). Prioridade `media`.
- **Dedup**: nenhuma das duas regras cria um 2º cartão aberto para o mesmo `item_id`+`rule_key` — só atualiza `updated_at` do cartão existente enquanto ele não for movido para `finalizado`/`excluido`.

**Cartão atrasado** (`due_date` vencido): um cartão com `due_date < now()` fora das colunas `finalizado`/`excluido` é considerado atrasado — mostra badge vermelho no próprio card (já existia antes desta regra ser documentada) e conta no KPI "Atrasadas" no topo do quadro (`GET /api/tasks/summary`). Uma vez por dia (job `checkTarefasAtrasadas`, 08:15 — ver `workers.md`), todo cartão atrasado ainda não notificado (`overdue_notified_at IS NULL`) dispara um alerta agregado único no Telegram (`tg_tarefas`, não um por cartão) e é marcado como notificado — não repete o alerta todo dia pro mesmo cartão. Editar o `due_date` do cartão (`PATCH /api/tasks/:id`) reseta `overdue_notified_at` pra `NULL`, permitindo notificar de novo se ele voltar a vencer.

**Exclusão permanente de cartão**: `DELETE /api/tasks/:id` (hard delete — sem soft-delete/lixeira) envia ao Telegram (`tg_tarefas`) todos os detalhes do cartão (título, descrição, prioridade, tags, responsável, loja/marketplace de origem, coluna, datas) **antes** de apagar a linha — única forma de auditoria depois da exclusão, já que o registro deixa de existir no banco.

## SEO Score — pesos e thresholds (`server/src/seoScore.js`, tabela `item_seo_score`)

**Não confundir com o score de `item_performance`** ("Score de qualidade baixo" acima) — são dois scores diferentes: `item_performance.score` vem pronto da API do ML (`/item/:id/performance`); o SEO Score é calculado inteiramente pelo sistema, fórmula própria, nunca chama esse endpoint. Calculado 1x/dia pelo job `sync-seo-score` (ver `workers.md`).

**Pesos** (somam 100 — normalizados proporcionalmente a partir da lista original do usuário, que somava 115; ver `decisions.md`):

| Indicador | Peso |
|---|---|
| Fotos | 13,04 |
| Vídeo | 8,70 |
| Título | 13,04 |
| Descrição | 8,70 |
| GTIN | 4,35 |
| Marca | 4,35 |
| Modelo | 4,35 |
| FULL | 6,96 |
| Catálogo | 8,70 |
| Atributos | 10,43 |
| Conversão | 13,04 |
| Visitas | 4,35 |

**Thresholds pra nota máxima em cada subscore** (constantes nomeadas em `THRESHOLDS`, ajustáveis sem precisar reler o código): `pictures_count >= 6` fotos, `title_length` até 60 caracteres (limite real do ML), `description_word_count >= 200` palavras, `conversion_rate >= 5%` (vendas/visitas 30d), `visits_30d >= 500`. GTIN/Marca/Modelo/FULL/Catálogo são binários (tem ou não tem, sem gradação). `attributes_score` é `1 − (required_attrs_missing / required_attrs_total)`, com nota máxima quando a categoria não tem nenhum atributo obrigatório (`required_attrs_total = 0`).

## Monitor de Buy-Box — "ganhando"/"perdendo" (`catalog_competition`, ver `decisions.md`)

Escopo: só itens com `item_seo_score.catalog_listing = true`. "Ganhando" é decidido comparando `catalog_competition.winner_item_id` ao próprio `item_id` — **não** pela string `catalog_competition.status` (só o valor `"competing"` foi confirmado ao vivo contra a API real; outros valores possíveis não foram documentados, então a UI/summary nunca dependem do texto exato). `summary.perdendo_buybox` (rota `GET /api/qualidade-anuncio`) conta itens `catalog_listing=true` com `winner_item_id` preenchido e diferente do próprio item — itens ainda sem sync (`winner_item_id IS NULL`) não entram nem como "ganhando" nem como "perdendo".

## Devoluções — prejuízo lançado manualmente (`returns.prejuizo`)

`returns.amount`/`order_amount` é o **valor do pedido** (quanto o comprador pagou), não necessariamente o que o vendedor efetivamente perdeu com a devolução — frete de volta, produto danificado, taxa não estornada etc. variam caso a caso e a API do ML não devolve esse número. Por isso o prejuízo é um campo **livre, digitado manualmente** pelo usuário por devolução (`pages/devolucoes.html`, coluna "Prejuízo (R$)", input numérico + botão Salvar, mesmo padrão da coluna "Observação").

- **`NULL` ≠ zero**: uma devolução sem prejuízo lançado ainda não foi avaliada — não conta como "prejuízo zero" em nenhum agregado. O card "Prejuízo Total" mostra também a quantidade de devoluções **com** prejuízo lançado (`prejuizo_qtd`), pra deixar claro que a soma é parcial enquanto nem toda linha foi preenchida.
- **Respeita o filtro de data já existente na página** (botões Hoje/Ontem/7/15/30 dias/Tudo, mais loja/busca, mais o filtro livre "De/Até" abaixo) — não é um filtro novo: o card de prejuízo é calculado em cima do mesmo `summary` que já respeita `date_from`/`date_to`, então trocar o período já atualiza o card automaticamente.
- **Filtro de data livre "De/Até"** (dois `<input type="date">`, `setPeriodoCustom()`): pedido explícito do usuário pra cobrir faixas que os botões de atalho não cobrem, ex. "01/07/2026 até 31/07/2026" (um mês inteiro específico). Escolher uma data desativa visualmente os botões de atalho (evita a impressão de que os dois filtros estão combinados); escolher um botão de atalho limpa os campos De/Até. Os dois preenchem o mesmo estado `periodoAtual`, então o resto da página (KPIs, tabela, card de prejuízo) não precisa saber qual dos dois foi usado.
- Salvar um prejuízo recarrega a listagem (`load()`) pra o card de KPI refletir o novo total na hora — diferente da Observação, que não afeta nenhum agregado e por isso não precisa recarregar.

## Devoluções — Taxa de Devolução e análises derivadas

**Fórmula única, usada em todo lugar que fala de "taxa"**: `Taxa de Devolução (%) = (Quantidade de Devoluções ÷ Quantidade de Pedidos) × 100`. "Pedidos" é sempre `orders`/`vw_ml_orders` com `status != 'cancelled'`, nunca o total bruto de pedidos (cancelado não é uma venda de verdade, não faz sentido nem no numerador nem no denominador).

- **Card "Taxa de Devolução"** (`GET /api/alertas/devolucoes`, campo `taxa_devolucao_pct`): devoluções = `rows.length` (já filtrado por período/loja/busca da tela), pedidos = contagem de `vw_ml_orders` no **mesmo período e loja**, mas **sem aplicar a busca livre `q`** — `q` filtra devoluções por texto (pedido/comprador/produto), e não faz sentido restringir "quantidade total de pedidos" por um termo de busca pensado pra achar uma devolução específica.
- **Ranking de Motivos**: contagem de `reason_detail` (ou `reason` cru se não houver tradução) entre as devoluções carregadas — 100% calculado no frontend, já que a tabela principal já traz esse campo por linha, sem chamada nova ao backend. Top 8, ordenado por quantidade.
- **Ranking de Produtos**: top 10 itens por nº de devoluções no período — só busca a contagem de `pedidos` dos `item_id` que aparecem nas devoluções (não itera o catálogo inteiro, que seria caro e desnecessário pra essa análise). `taxa_pct` do item é `null` quando não há nenhum pedido do item no mesmo filtro (caso raro: pedido antigo fora da janela, item com `item_id` nulo no `orders`, etc.) — mostrado como "—", não como 0%.
- **Taxa por Loja**: só é renderizada quando (a) nenhuma loja específica está selecionada (`store_id` vazio — com uma loja só, seria uma linha redundante com o KPI principal) e (b) há pedidos em mais de 1 loja no período. Ordenado da taxa mais alta pra mais baixa — a pior loja aparece primeiro, de propósito.
- **Correlação com Logística**: bucket Flex/Mercado Envios/Full feito pela mesma função `logLabel()` já usada na tabela principal e em `top-vendas-online.html`/`embalagem.html` — não duplica a classificação. Backend só devolve a contagem crua por `shipping_type` (`pedidos_por_logistica`); devoluções por logística vêm de `rows` já carregadas.
- **Tempo Médio de Resolução**: só conta devoluções com status final (`approved`/`resolved`/`rejected`/`closed`) e com `date` e `last_updated` presentes — uma devolução ainda "em análise" não tem prazo de resolução conhecido, não entra na média. Fórmula é soma total de horas ÷ nº de devoluções encerradas (não "média das médias"), mesmo raciocínio já usado no "Tempo médio / pedido" da Embalagem (ver `embalagem.md`).
- **Gráfico de Evolução da Taxa** (`GET /api/alertas/devolucoes/evolucao`): série diária dos últimos 30/60/90 dias, **independente do filtro de período da tabela principal** — só respeita a loja selecionada. É proposital: o card/tabela respondem "como está o período que eu escolhi agora", o gráfico responde "isso está piorando ou melhorando ao longo do tempo", perguntas diferentes que não deveriam compartilhar o mesmo range de datas.
- **Alerta Telegram de taxa alta** (`checkTaxaDevolucaoAlta`, worker, 06:30 diário — ver `workers.md`): por loja ML, últimas 24h, `TAXA_DEVOLUCAO_ALERTA_PCT = 5` (5%) e `TAXA_DEVOLUCAO_AMOSTRA_MIN = 10` pedidos — lojas com menos de 10 pedidos no dia são ignoradas, porque com amostra pequena 1 devolução já vira uma taxa de 10%+ sem significar nada estatisticamente. Reaproveita o tópico Telegram `tg_devolucoes` já existente (mesmo usado por "Nova devolução solicitada" e pelo sync retroativo) — não criou um tópico novo. Os dois limiares são constantes fixas no topo de `worker.js`, ajustáveis se a operação real mostrar que os valores não fazem sentido.

## Fechamento financeiro diário — lucro real + alerta de MC% baixa (`fechamentoDiario`, 06:05)

Relatório operacional matinal (`tg_fechamento`, `tgNotifyForce` — não respeita silêncio, é fechamento e não alerta) com o **lucro real** (Margem de Contribuição) do dia anterior por loja, via `getMargemPorLoja` (mesma fonte da tela Vendas por Loja, ver `finance.md`). Cada loja mostra Aprovadas, Custos (custo+imposto+tarifa+frete vendedor), Margem e MC%. Roda **depois** do `mp-reports` (05:40) pra usar a conciliação fresca do dia. Lojas com **MC% abaixo do limite** (`app_config.mc_pct_min`, fallback env `MC_PCT_MIN`, default **8%**) são marcadas com ⚠️ e resumidas no rodapé — é o "alerta quando a margem cai". Lojas sem venda aprovada não entram; loja sem taxa real no período é marcada "taxa estimada".

## "Nova venda!" — quando notificar

Uma notificação Telegram de nova venda só dispara na **transição real** de status para `paid` (`previousStatus !== 'paid' && order.status === 'paid'`). Um webhook tardio de `shipments`/`payments` que reprocessa um pedido já pago não gera notificação duplicada. Syncs agendados (`syncVendas`) chamam `handleOrder` com `silent: true` para nunca notificar em reconciliação retroativa.

## Ruptura iminente — dias restantes por velocidade real (`getRupturaEstoque`, alerta 07:30)

Diferente do alerta de estoque fixo (`≤5`/`≤15`): mede **quando** o item acaba, não só quanto tem. `dias_restantes = available_quantity ÷ (unidades vendidas na janela ÷ dias da janela)`, com a **velocidade real** de `vw_ml_orders` (não `sold_quantity` histórico). Entra na lista só quem **vende bem** (`venda_dia ≥ min_venda_dia`, default 0.2 = ≥1 venda a cada 5 dias) **e** tem `dias_restantes < dias` (default 7, janela 30d). `sugestao_compra = ceil(venda_dia × janela) − estoque` (repor pra cobrir 1 janela). Job `checkRupturaEstoque` (07:30) manda os 12 mais urgentes no Telegram (`tg_reposicao`, respeita silêncio). Objetivo: reagir antes de perder venda por ruptura — complementa a página Reposição (que olha estoque baixo em geral) com "vende bem E vai acabar".

## Estoque — thresholds diferentes por contexto

- **Alerta em tempo real** (worker, tópico `stock_alert`, notificação Telegram `tg_reposicao`): dispara quando `available_quantity <= 5`.
- **Página de Reposição** (`GET /api/alertas/reposicao`): threshold configurável via query param, padrão `15`; classificado em faixas: `zero` (0), `critical` (1–3), `low` (4–10), `medium` (>10).
- **Dashboard/alertas gerais** (`GET /api/dashboard/alerts`): lista itens com `available_quantity <= 5`, top 10 por menor estoque.

Esses três valores não são a mesma constante em três lugares — são decisões independentes por tela. Não unificar sem avaliar o impacto em cada uma.

## "Estoque parado"

Um item é considerado parado (`GET /api/analises/estoque-parado?modo=parado`) quando está `status='active'`, tem `available_quantity > 0` e teve **zero vendas** no período selecionado (padrão 30 dias). Não olha para tempo desde o cadastro nem para tendência — é uma contagem binária de vendas no período.

## Curva ABC

Classificação por % acumulado de faturamento dentro do período filtrado, ordenado do item de maior para o de menor receita:
- **A**: até 80% acumulado
- **B**: de 80% a 95% acumulado
- **C**: acima de 95% acumulado

## Clientes novos vs. recorrentes

Em `GET /api/clientes`: "novo do mês" = primeiro pedido (`MIN(date_created)`) dentro do mês corrente; "recorrente" = `total_orders > 1` no período consultado (`days`, padrão 365). Pedidos cancelados nunca contam para esses agregados.

## Promoções — transições de status notificadas

O worker (`handleOffer`) compara o `status` anterior salvo em `promotions` com o novo:
- Estava `active` e deixou de estar → "🔴 Saiu da promoção!" (`tg_promocoes`).
- Não tinha registro anterior, ou não estava `active` e passou a estar → "🟢 Entrou em promoção!".
- Qualquer outra mudança de status → "🏷️ Promoção alterada" (genérico).

## Top Vendas — alerta periódico de itens mais vendidos

`syncTopVendas` (a cada 4h — 00h/04h/08h/12h/16h/20h) envia ao Telegram o top 5 itens (por unidades vendidas, não receita) das **últimas 4h**, não do dia acumulado — é uma janela deslizante para dar visibilidade do que está vendendo "agora" e permitir reação rápida de reposição de estoque, não um relatório histórico. Cada linha inclui o nome da loja (`stores.nickname`). Pedidos cancelados não contam. **Não notifica se não houve nenhuma venda no período** (evita 6 mensagens/dia de "nada vendeu"). Não usa `tgNotifyForce` — respeita a janela de silêncio e pode ser desligado individualmente (`tg_topvendas`), diferente do resumo diário e dos relatórios de sync (que são "operacionais", não "alertas").

## Relatórios por e-mail (Resend) — o que difere do alerta de Telegram

Mesmo dado, propósito diferente: os relatórios por e-mail (`emailDailyReports`, `emailRelatorioSemanal`) são **digest**, não alerta em tempo real — por isso rodam bem menos vezes que os equivalentes de Telegram:

- **Top vendas por e-mail é janela de 24h** (top 10), não 4h (top 5) como o alerta de Telegram — faz mais sentido como "os melhores do dia" num resumo diário do que como snapshot frequente.
- **Resumo diário por e-mail** reaproveita a mesma consulta do `resumoDiario` do Telegram (`getResumoDiarioData()`) — mesmo conteúdo, dois formatos/canais.
- **Relatório semanal** é exclusivo do e-mail (não existe versão Telegram) — toda 2ª-feira, cobre pedidos/receita/margem dos últimos 7 dias comparados aos 7 dias anteriores, por loja, e curva ABC top 10. Margem usa a mesma fórmula de `GET /api/vendas/detalhado` (ver `finance.md`) — não recalcular com fórmula diferente.
- Cada um dos 3 relatórios tem seu próprio toggle (`email_resumo`/`email_topvendas`/`email_semanal`, `app_config`) — desligado por padrão, o usuário liga pelo Monitor.
- **Não notifica se não há dado no período** (mesma regra do `syncTopVendas`) — evita e-mail vazio.
- Credencial do Resend (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`RESEND_TO_EMAIL`) só via `.env` do servidor, nunca pela UI — só os 3 toggles são editáveis pelo Monitor (ver `decisions.md`).

## Notificações Telegram — regras de silêncio e throttle

Cada tópico (`tg_vendas`, `tg_perguntas`, etc.) pode ser individualmente desativado em `app_config`. Além disso, globalmente:
- **Janela de silêncio**: nenhuma notificação via `tgNotify` (não `tgNotifyForce`) é enviada entre `silence_start` e `silence_end` (padrão 22:00–07:00, horário local do processo).
- **Intervalo mínimo por tópico**: `tg_interval` (minutos) — se >0, um mesmo tópico não pode notificar de novo antes desse intervalo, mesmo com múltiplos eventos.
- **Notificações que ignoram tudo isso** (`tgNotifyForce`): resultado dos syncs agendados (`tg_infra`) e o resumo diário (`tg_resumo`) — são consideradas relatórios operacionais, não alertas em tempo real.
- **Rate limit de alertas de rate limit**: `track429` só notifica `tg_429` depois de 3 cooldowns de 429 na mesma loja em uma janela de 10 min, e depois espera outros 10 min antes de notificar de novo — evita spam de alerta quando a API do ML está instável.

## Projeção de faturamento do mês (`GET /api/vendas/hoje`)

`projecao_mes` é um **run-rate simples**, não regressão linear (diferente da "projeção de fechamento" da página BI `analise-vendas-mes.html`, que usa reta de regressão — ver acima): `receita acumulada do mês corrente ÷ dias já decorridos × total de dias do mês`. Recalculado a cada carregamento, sempre para o mês corrente real (não aceita filtro de mês/ano) — por isso não tenta reaproveitar a query de `/api/analises/vendas-mes`, que é filtrável e mais pesada (múltiplas agregações de 12 meses). Não filtra por loja (mesmo comportamento do resto de `/vendas/hoje`, que sempre soma todas as lojas ML).

## Vendas ML Turbo é a fonte financeira "oficial"

A tabela `orders` (webhook-driven) é usada para tudo que é operacional em tempo real (dashboard, pedidos, análises temporais). Mas o **cálculo financeiro definitivo** (margem, ROI, custos completos) é feito a partir da planilha importada em `ml_turbo_sales`, não a partir de `orders` — porque a planilha do Mercado Turbo já vem com tarifas, impostos e fretes exatos calculados pelo próprio ML, enquanto `orders` reconstrói esses valores a partir de campos parciais do payload do webhook (ver `finance.md` para as duas fórmulas lado a lado).

## Detecção de coluna "conta" (loja) na planilha Turbo

O campo `account` no upload da planilha (`ml_turbo_sales.account`) é texto livre, sem chave estrangeira para `stores.id` — é o nome da conta como aparece na coluna "Conta"/"Loja"/"Vendedor" da planilha exportada pelo Mercado Turbo. Isso significa que corrigir o nome de uma loja depois de importar não atualiza vendas já importadas — é preciso reimportar a planilha. Mapeamento de aliases de coluna documentado em `finance.md`.

## Conciliação Bancária — limiares do alerta de divergência (`checkConciliacaoDivergencias`, 05:25)

Dois limiares fixos, sem base estatística histórica ainda (feature recém-lançada, sem volume suficiente pra calcular algo como o desvio-padrão usado no outlier de vendas):
- **Diferença bruto/líquido ≥ 50%** (`CONCILIACAO_DIFERENCA_ALERTA_PCT`, `worker.js`) — diferenças normais observadas ao vivo ficam na faixa de 20–31% (comissão + parcelamento); 50% é uma margem de segurança generosa pra não gerar alerta em toda venda parcelada, só em casos realmente fora do padrão.
- **Liberação atrasada em +2 dias** (`CONCILIACAO_LIBERACAO_ATRASO_DIAS`) — pagamento passou de `money_release_date` e continua `released != 'yes'`; 2 dias de folga absorve variação normal de horário/fuso sem gerar alerta prematuro.

Ambos ajustáveis por constante no topo da função — revisar quando houver volume/histórico suficiente pra um limiar estatístico de verdade. Dedup 1x por pagamento via `ml_payments.alert_notified_at` (v32), tópico Telegram `tg_conciliacao`. Ver `conciliacao-bancaria.md`.

## Conciliação Bancária — mapeamento de Status de Entrega (v33)

Status cru de `/shipments/:id` (campo `status` — confirmado ao vivo pra `pending`/`ready_to_ship`; os demais vêm do vocabulário documentado da API, ainda não observados em produção) → bucket de UI exibido na coluna "Entrega":

| Status cru ML | Bucket | Label | Emoji/cor |
|---|---|---|---|
| `pending` | `aguardando` | Aguardando envio | ⚪ (sem cor) |
| `handling`, `ready_to_ship` | `preparando` | Preparando | 🔵 azul |
| `shipped` | `transito` | Em trânsito | 🟡 amarelo |
| `delivered` | `entregue` | Entregue | 🟢 verde |
| `cancelled` | `cancelado` | Cancelado | 🔴 vermelho |
| `not_delivered` | `nao_entregue` | Não entregue | 🟠 (tag amarela) |

`not_delivered` é um bucket extra, não fazia parte do pedido original — adicionado porque é um status real do vocabulário da API do ML que não se encaixava nos outros 5 (tentativa de entrega falhou, sem ser necessariamente cancelamento). Tabela replicada em dois lugares por não haver runtime compartilhado entre a página estática e o Node: `SHIPPING_STATUS_MAP` (`pages/conciliacao-bancaria.html`, pra badge/tooltip) e `SHIPPING_STATUS_BUCKETS` (`routes/api.js`, pra traduzir o filtro `entrega` em lista de status crus no `WHERE`). Ver `conciliacao-bancaria.md`.

## Alertas de monitoramento de concorrente — limiares (v60)

Quando um snapshot de concorrente (Análise de Produtos) muda em relação ao último estado conhecido, dispara alerta (Telegram + relatório no card). Limiares, todos ajustáveis por env sem deploy (`server/src/analise/monitor.js`):

| Gatilho | Condição | Env (padrão) |
|---|---|---|
| Preço subiu/caiu | variação `|Δ%|` ≥ limiar | `ANALISE_ALERT_PRICE_PCT` (**3**) |
| Estoque zerou | `available_quantity`: era > 0 → 0 | — |
| Estoque voltou | era 0 → > 0 | — |
| Pausou | `status` → `paused` | — |
| Encerrou | `status` → `closed`/`under_review` | — |
| Disparada de vendas | `sold_delta` do dia ≥ limiar | `ANALISE_SALES_SPIKE_MIN` (**15**) |

Regras: **só transição real** dispara (nunca a cada snapshot idêntico); **dedup** por `(ml_id, tipo, novo valor)` nas últimas **20h** evita o job diário e o "Monitorar agora" avisarem a mesma mudança duas vezes; o Telegram usa `tgNotifyForce` (ignora throttle/silêncio — o dedup já contém o volume) e pode ser desligado com `app_config.tg_monitor_analise='false'`. Ver `analise-produtos.md`.

## Vendas por Loja — Bruto vs. Líquido de devoluções (`/vendas/por-loja`)

A "Receita" da página é **bruta**: `SUM(total_amount)` de pedidos **não cancelados** (cancelado sai; devolução **não** sai sozinha, pois vive em `returns`, tabela separada, e o pedido continua pago). Para dar o **líquido**, a rota devolve `devolucoes` por loja e a página mostra **Bruto − Devoluções = Líquido**. Regras da devolução abatida:
- **Valor** = `COALESCE(NULLIF(returns.amount,0), orders.total_amount)` — valor da reclamação do ML quando > 0, senão o pedido cheio (decisão do usuário).
- **Casada com a VENDA** (data do pedido no período), não com a data da devolução — pra o líquido bater com as vendas daquele range. Consequência aceita: uma devolução que chega depois muda retroativamente o líquido do período da venda.
- **Só pedidos não cancelados** (o cancelado já saiu do bruto — evita dupla baixa).
- Segue sendo **bruto de tarifa/frete/imposto/custo** — líquido aqui é só "menos devoluções", não é lucro. Lucro real fica em Conciliação / Análise de Vendas do Mês (`finance.md`).

## Rankeamento — fase Recuperação: diagnóstico e prazos (v80)

Anúncio parado (`fase = 'recuperacao'`, ver `rankeamento.md`). Os números abaixo são a régua do card; são **chute inicial calibrável**, não vêm do ML.

**Diagnóstico** — cruza tráfego × conversão pra dizer *o que* mexer (`diagnosticar()` em `routes/ranking.js`); visitas/dia = `last_visits` (fallback: média 7d de `item_visits`), conversão = `item_seo_score.conversion_rate` (razão 0..1, janela de 30 dias):

| Condição | Veredito | Ação sugerida no card |
|---|---|---|
| visitas/dia = 0 | `INVISIVEL` | status, estoque, categoria errada |
| visitas/dia < **10** | `EXPOSICAO` | ADS, título/palavras-chave, categoria, preço de entrada |
| visitas ≥ 10 e conversão < **1%** (ou sem histórico) | `OFERTA` | preço, fotos, descrição, frete, atributos |
| visitas ≥ 10 e conversão ≥ 1% | `VOLUME` | falta tráfego: ADS e posicionamento |
| sem `last_visits` ainda | `SEM_DADOS` | aguardar o snapshot (6/6h) |

**Semáforo do tempo parado** (dias desde `last_sale_at`, ou desde `started_at` se **nunca** vendeu): 🟡 `observando` 0–7 · 🟠 `atencao` 8–14 · 🔴 `decisao` 15+. Ao entrar em `decisao` sai **um** alerta `sem_resultado` no Telegram por passagem pela fase. O semáforo **só marca** — excluir/encerrar é sempre decisão manual no card.

**Janela de medição da intervenção: 7 dias.** Antes disso o veredito é `medindo`; depois: venda no período → `funcionou`; visitas **+20%** sem venda → `parcial`; visitas **−20%** → `piorou`; nada disso → `sem_efeito`. O baseline é carimbado no registro da intervenção e o efeito é calculado na leitura (nunca gravado, então sempre reflete o dado mais recente).

**Checklist do card** (o que o ML já nos diz, via `item_seo_score`): fotos < 6 ❌ · sem vídeo ❌ · atributos obrigatórios faltando ❌ · título < 55 caracteres ⚠️ · descrição < 100 palavras ⚠️. Ordem de exibição: ❌ → ⚠️ → ✅ (pendência primeiro).

## Inteligência de Margem — motor determinístico (`GET /api/bi/margem`)

> Fonte de verdade dos limiares usados por `pages/bi-margem.html`. Todo campo é agregação real sobre `orders`/`items`/`stores` — o motor NUNCA inventa número (pedido explícito do usuário); nada aqui passa por LLM. Fórmula de margem por pedido é a mesma de `finance.md`/`vendas/detalhado`, só agregada por anúncio (`item_id`).

- **Comparação de período**: sempre janela atual vs. janela **anterior de mesma duração** (não o mês inteiro anterior) — mesmo princípio do Painel Estratégico.
- **"Alto faturamento"** = o anúncio pertence à **Curva A** (mesma regra de `/api/comparativos/curva-abc`: ≤80% do faturamento **acumulado**, ordenado do maior pro menor, acumula-e-só-depois-confere). Por **fatia** de faturamento, não por contagem de SKUs — um corte por índice (ex.: "top 20% dos anúncios") fica frágil com poucos produtos (facilmente ninguém passa do corte). **Exceção**: se o portfólio é tão concentrado que nem o próprio líder de faturamento chega aos 80% sozinho (situação comum com poucos SKUs — o item, sozinho, já é 100% de si mesmo), o líder por faturamento sempre entra no grupo — é definicionalmente quem mais fatura, não pode ficar de fora.
- **MC% baixa = < 15%. MC% alta = ≥ 30%.** Pontos percentuais, ajustáveis — não é uma verdade universal, é o limiar desta tela (compatível com o exemplo do próprio usuário: Whiskas Kit 6 a 13,1% MC é sinalizado como baixa margem).
- **Classificação** (nessa ordem — a primeira regra que bater decide):
  1. `margem < 0` → **PREJUÍZO** (⚫), sempre, independente de volume.
  2. Alto faturamento + MC ≥ 30% → **ESTRELA** (🟢).
  3. Alto faturamento + MC < 15% → **VOLUME COM BAIXA MARGEM** (🟡) — "esse grupo é crítico" (linguagem do próprio usuário).
  4. Não-alto faturamento + MC ≥ 30% → **ALTA MARGEM / BAIXO VOLUME** (🔵).
  5. MC < 15% (fora dos casos acima, ou seja, volume médio/baixo) → **DESTRUIDOR DE MARGEM** (🔴) — gera faturamento mas contribui pouco.
  6. Resto (MC entre 15% e 30%, faturamento não classificado acima) → **NEUTRO**.
- **Estoque & ruptura** — mesma fórmula de `getRupturaEstoque` (`reports.js`): `venda/dia = unidades vendidas no período ÷ dias`; `dias de estoque = estoque atual ÷ venda/dia`; `data de ruptura = hoje + dias de estoque`. Faixas: **RUPTURA_IMINENTE** ≤7 dias (mesmo limiar já usado como "iminente" em `getRupturaEstoque`, não uma constante nova) · **SAUDÁVEL** 8–60 dias · **EXCESSO** > 60 dias · **SEM_VENDA_NO_PERIODO** (tem estoque, zero venda no período — não dá pra estimar velocidade) · **ZERADO** (estoque = 0). Sem estoque sincronizado (`estoque_atual = null`) não quebra: fica `SEM_VENDA_NO_PERIODO` sem dias/data.
- **Score 0-100**, com breakdown sempre visível (nunca um número sem explicação): percentil de MC% dentro do portfólio analisado × 35 + percentil de faturamento × 25 + percentil de margem R$ × 25 + pontos de estoque (SAUDÁVEL=15 · EXCESSO=8 · RUPTURA_IMINENTE=5 · sem dado=12, neutro — não penaliza por falta de dado). Percentil com 1 único item analisado = 1 (não penaliza por falta de comparação).
- **Ações recomendadas** — cada uma com premissa explícita, nunca uma previsão disfarçada de fato:
  - **PREJUÍZO** → pausar/renegociar; impacto = prejuízo já realizado no período (premissa: repetir o período repetiria o prejuízo).
  - **VOLUME_BAIXA_MARGEM/DESTRUIDOR_MARGEM** → reprecificar, com **3 cenários simulados** (`cenarios[]` = +3%/+5%/+10%, `CENARIOS_REPRECIFICACAO` em `routes/bi.js`); impacto de cada cenário = `(pct/100) × (faturamento − imposto − tarifa)` — premissa: volume constante em todos os cenários, tarifa/imposto escalam com o preço (são %), custo do produto e frete do vendedor ficam fixos por unidade. `impacto_estimado` do topo da ação continua sendo o cenário de +5% (compatibilidade com o ranking por impacto).
  - **ALTA_MARGEM_BAIXO_VOLUME** → aumentar exposição; impacto = margem atual do período — premissa: dobrar o volume mantém a mesma MC%.
  - **RUPTURA_IMINENTE com margem positiva** → repor estoque; impacto = `venda/dia × 7 × margem por unidade` — premissa: 7 dias de ruptura na mesma velocidade de venda do período.
  - **Frete do vendedor > 15% do faturamento do anúncio** → revisar frete; sem estimativa em R$ (depende de qual alternativa for escolhida) — mostrado como "sem estimativa em R$", nunca inventado.
  - Ranking final: as 10 de maior `impacto_estimado` (ações sem impacto em R$ ficam no fim, nunca em 1º).
  - **Exclusividade mútua ao somar impacto** (`impactoTotalSemDuplicar()`, `bi-margem-acoes.html`): um mesmo `item_id` pode ter mais de uma ação simultânea — a do bloco classificação (PAUSAR_OU_RENEGOCIAR/REPRECIFICAR/AUMENTAR_EXPOSICAO, sempre só 1 dessas 3 por item) **mais**, independentemente, REPOR_ESTOQUE e/ou REVISAR_FRETE. Somar `impacto_estimado` de todas as ações do mesmo produto infla o total (competem pela mesma oportunidade, não se somam). O KPI "Impacto total priorizado" soma só o MAIOR `impacto_estimado` por `item_id`, não todas as ações daquele produto. A lista/ranking individual de ações continua mostrando todas (não é sobre esconder ação, é sobre não dobrar a soma).
- **Amostra pequena** (`amostra_pequena`, `AMOSTRA_MINIMA = 3` em `routes/bi.js`): anúncio com menos de 3 pedidos no período recebe esse aviso — classificação/score continuam calculados normalmente (a conta não muda), só sinaliza que 1-2 vendas podem não ser representativas (ex.: 1 venda com prejuízo isolado já classifica como DESTRUIDOR_MARGEM/PREJUÍZO). Renderizado como ícone de alerta ao lado da classificação em `bi-margem-produtos.html`.
- **Decomposição da variação de margem** (`resumo.causa_variacao`, card "Por que a margem mudou" em `bi-margem.html`): identidade EXATA, não estimativa — como `margem = faturamento − custo − imposto − tarifa − frete_comprador − frete_vendedor`, a variação entre período atual e anterior se decompõe sem resto em `Δfaturamento − Δcusto − Δimposto − Δtarifa − Δfrete_comprador − Δfrete_vendedor` (a soma dos 6 componentes sempre bate com `delta_margem`, isso é garantido pela própria fórmula, não recalculado à parte). Cada componente já vem com sinal certo pro lucro (ex.: custo que subiu entra como contribuição NEGATIVA).
  - **Indicador de mix** (`causa_variacao.mix`), separado do waterfall acima pra não dividir a mesma variação duas vezes: % do faturamento do período que vem de anúncios com MC% agregada abaixo do limiar de MC baixa (15%), comparando atual vs. anterior. Sinaliza concentração crescente em produtos de margem ruim mesmo quando cada SKU individualmente não mudou de preço/custo.
- **Tendência semanal por SKU** (`tendencia_semanal[]`, sparkline em `bi-margem-produtos.html`): agregação por semana ISO (segunda-feira como chave) numa janela **fixa de 42 dias (6 semanas) terminando no FIM do período selecionado** (não necessariamente hoje — "mês anterior" mostra tendência até o fim daquele mês). SKU sem venda na janela tem `tendencia_semanal: []` (frontend mostra "sem histórico", não um gráfico vazio/quebrado).
- **Período flexível** (`days` OU `date_from`/`date_to`, `routes/bi.js`): a tela Visão Geral (`bi-margem.html`) resolve os filtros Hoje/Ontem/Mês atual/Mês anterior/personalizado em datas explícitas no CLIENTE (`resolverPeriodo()`) e manda `date_from`/`date_to` ao backend; as outras 5 páginas continuam só com `days` (7/14/30/60/90). Quando `date_from`/`date_to` vêm preenchidos, o backend ignora `days` e calcula a duração real do intervalo — o período ANTERIOR usado em toda comparação (`causa_variacao`, `mudancas`, `cresc_*_pct`) tem sempre essa MESMA duração, imediatamente antes do início do período atual. Só `days`/`store_id` sobrevivem à navegação entre as 6 páginas (contrato de `js/biMargemTabs.js`) — período explícito e categoria são filtros locais da Visão Geral (ver `decisions.md`).
- **Filtro de categoria** (`category_id`, `items.category_id`): opções do seletor vêm do próprio payload já carregado (`produtos[].category_id`, únicos), mesmo padrão já usado em `qualidade-anuncio.html` — categoria é o ID cru do Mercado Livre (ex. `MLB1234`), sem nome legível (não existe lookup de nome de categoria no projeto).

## Imposto — vendas Flex isentas por padrão (flag geral `imposto_flex_ativo`)

> Pedido explícito do usuário: vendas por **Mercado Envios Flex** (`orders.shipping_type='self_service'`) não têm nota fiscal emitida, então por padrão elas não devem entrar com imposto em nenhum cálculo de margem.

- **Flag GERAL, não por loja** — `app_config.key='imposto_flex_ativo'` (`'true'`/ausente-ou-qualquer-outro-valor = false), mesmo padrão key/value já usado por `tg_*`/`email_*`. **Padrão do sistema = desligada** (imposto NÃO cobrado em Flex) — pedido explícito ("por padrão não deve calcular"). `GET`/`PATCH /api/config/imposto-flex`.
- **Onde a flag é respeitada**: só nos consumidores de `calcularMargemLinha`/`VENDA_DETALHE_SELECT` (`server/src/vendaMargem.js`, fonte única da fórmula de margem por pedido) — `GET /api/vendas/detalhado` (Resumo por Venda, linhas E o card de totais agregados em SQL própria), `GET /api/bi/margem*` (Inteligência de Margem: Visão Geral, Produtos, Portfólio, Frete, Estoque, Ações, drill-down por SKU), `GET /api/bi/rankeamento` (Vendas por Estágio) e `POST /api/vendas/:orderId/atualizar`/`financeReconciliationJob`.
- **Fórmula**: `imposto = (shipping_type==='self_service' && !imposto_flex_ativo) ? 0 : total_amount × imposto_pct/100`. Só o termo `imposto` muda — tarifa/frete/custo continuam exatamente iguais pra Flex, a margem simplesmente fica maior por não descontar um imposto que não existe de verdade.
- **`buscarImpostoFlexAtivo()` lida 1x por request** (não por linha) e passada como 2º parâmetro pra `calcularMargemLinha(row, impostoFlexAtivo)` — evita 1 query de config por pedido.
- **NÃO estendida a outros cálculos de imposto do sistema** (`GET /api/vendas/hoje`, `/vendas/hoje-vs-ontem`, `/pedidos/:id/detalhes`, relatórios de `reports.js`, `/vendas/margem`/`lojas.html`) — essas rotas calculam imposto direto em SQL própria, sem passar por `calcularMargemLinha`. Decisão explícita do usuário de não estender a flag pra lá nesta tarefa (perguntado e confirmado) — ver `known-bugs.md` pro risco de números diferentes de imposto/lucro pra mesma venda em telas diferentes.
- **UI**: checkbox "cobrar imposto em vendas Flex" em `bi-vendas.html` (Resumo por Venda) — lida no carregamento (`GET`), grava e recarrega a lista ao mudar (`PATCH`). Não existe controle equivalente nas páginas de Inteligência de Margem (a flag é a mesma, só o ponto de edição é único).

## Priorização de reposição (`prioridade_score`, `bi-margem-estoque.html`)

> 100% client-side (`calcularPrioridade()`), não é um campo do backend — o payload de `GET /api/bi/margem` já traz `dias_estoque`/`mc_pct`/`venda_dia`/`custo_unitario` por SKU, suficiente pra calcular no cliente sem round-trip. Objetivo explícito do usuário: "um produto de margem ruim não deve furar a fila só por estar com estoque baixo" — dias restantes sozinho (ordenação padrão da tabela) não captura isso.

- **3 componentes, pesos fixos**: urgência 50% + margem 30% + velocidade de venda 20%.
- **Urgência e margem usam ESCALA ABSOLUTA** (`escalaLinear`, mesmo padrão de `scoreRentabilidade`/`scoreCrescimento` da Saúde do Negócio acima), não percentil dentro do conjunto de SKUs do período. Percentil foi a primeira tentativa e foi descartada por um teste (`bimargem-estoque-fase-e-test.js`): com poucos SKUs em ruptura no período (caso comum), o rank vira tudo-ou-nada — 2 itens = só posição 0 ou 1 — e uma diferença real de 1 dia de estoque (ex.: 2 dias vs. 3 dias) virava 50 pontos de score, o suficiente pra um produto de MC 5% furar a fila na frente de um de MC 60% só por ter 1 dia a menos de estoque. Escala absoluta não depende de quantos SKUs estão no conjunto.
  - **Urgência**: `escalaLinear(dias_estoque, 0, 100, 60, 0)` — 0 dias = 100 pontos, 60 dias = 0 pontos. O limite de 60 é o mesmo corte SAUDÁVEL/EXCESSO já usado pra `status_estoque` (não é uma constante nova). Só varia ~5–10pp entre um item de 2 dias e um de 7 dias (ambos dentro da faixa RUPTURA_IMINENTE), deixando margem decidir o desempate dentro da faixa urgente — que é exatamente o comportamento pedido.
  - **Margem**: `escalaLinear(mc_pct, MC_BAIXA=15, 0, MC_ALTA=30, 100)` — mesmos limiares de MC_BAIXA/MC_ALTA já usados na classificação de produto e na Saúde do Negócio, duplicados aqui (página estática sem import, mesma convenção já usada pra `fmtFreteLabel`/limiares de anomalia em `bi-margem-frete.html`).
  - **Velocidade**: continua por percentil dentro do conjunto — não existe threshold de negócio estabelecido pra venda/dia (varia demais por categoria/ticket), e é o componente de menor peso (20%).
- Produto sem `dias_estoque` (nunca vendeu no período, sem velocidade pra estimar) → `prioridade_score = null`, vai pro fim da lista quando ordenado por prioridade (nunca inventa um score).

## Saúde do Negócio (`saude`, `GET /api/bi/margem`)

> Card na Visão Geral (`bi-margem.html`). Score 0-100, **100% determinístico** (`calcularSaude()` em `routes/bi.js`) — 6 sub-scores de peso IGUAL (100/6 cada), nenhum passa por IA. Fórmulas/limiares abaixo são ajustáveis, não "verdade universal". Ordem de prioridade do próprio usuário — lucro > margem > eficiência > capital > crescimento > faturamento — por isso rentabilidade usa MC% (não faturamento) e crescimento usa a variação de MARGEM (não de faturamento).

- **Rentabilidade**: MC% do período, reaproveitando os limiares já existentes (MC_BAIXA=15/MC_ALTA=30). `≤0% → 0`; `0–15% → 0–50` (linear); `15–30% → 50–100` (linear); `≥30% → 100`.
- **Crescimento**: `cresc_margem_pct` (variação de LUCRO vs. período anterior, não de faturamento). `≤-20% → 0`; `-20%–0% → 0–50`; `0%–20% → 50–100`; `≥20% → 100`.
- **Eficiência logística**: `(frete do vendedor + tarifa) / faturamento` do período atual, agregado. `≤10% → 100`; `10–25% → 100–50`; `25–40% → 50–0`; `≥40% → 0`.
- **Saúde do estoque**: % dos anúncios com `dias_estoque` calculável (isto é, com venda/dia > 0 — exclui `SEM_VENDA_NO_PERIODO`/`ZERADO`, que não têm velocidade pra medir) que estão em `SAUDAVEL`. Sem nenhum anúncio aplicável → 100 (neutro, não penaliza por falta de dado).
- **Concentração de portfólio**: catálogo com ≤10 SKUs → 100 sempre (com poucos produtos, concentração alta é matematicamente inevitável, não é risco). Senão, usa `top10_pct_faturamento`: `≤50% → 100`; `50–80% → 100–40`; `>80% → 40–0` (mesmo corte de 80% da Curva ABC).
- **Eficiência comercial**: % do faturamento do período vindo de anúncios classificados ESTRELA/ALTA_MARGEM_BAIXO_VOLUME/NEUTRO (saudáveis) — o complemento é o % vindo de VOLUME_BAIXA_MARGEM/DESTRUIDOR_MARGEM/PREJUIZO (perigosos).
- **Score final** = média simples dos 6 sub-scores (arredondados). Sem peso maior pra nenhum — decisão consciente de simplicidade nesta primeira versão (ver `decisions.md`); recalibrar pesos é mudança de fórmula, não de arquitetura.

## "O que mudou" (`mudancas`, `GET /api/bi/margem`)

> Card na Visão Geral. 8 destaques determinísticos: maior alta/queda de faturamento, maior alta/queda de margem, maior alta de frete, maior alta de tarifa, maior alta/queda de pedidos — todos por SKU, comparando período atual vs. anterior (mesma duração).

- SKU que só existe num dos dois períodos entra com o lado ausente = 0 — um produto novo que começou a vender no período atual É, de fato, o "maior aumento de faturamento" válido (não é tratado como exceção).
- Se o maior delta de um campo for exatamente 0 (nada mudou), o card mostra "Sem mudança relevante" em vez de destacar um SKU aleatório com delta zero.
- Frete/tarifa só têm a direção "maior aumento" (pedido explícito do usuário) — o objetivo é alertar sobre alta de custo logístico, não comemorar queda.

## Ranking de impacto de frete/tarifa e anomalias (`bi-margem-frete.html`)

- **Ranking por produto**: 100% client-side sobre `DADOS.produtos` (já vem no payload de `/api/bi/margem`) — sem endpoint novo. `mc_antes` = MC% sem descontar tarifa/frete do vendedor (`(faturamento−custo−imposto)/faturamento`); `impacto_pp` = `mc_antes − mc_pct` (quantos pontos percentuais de margem frete+tarifa comeram, juntos). Ordenado por maior impacto (maior destruição de margem) por padrão, colunas clicáveis pra reordenar (client-side, mesmo padrão de `bi-margem-produtos.html`).
- **Anomalia de frete/tarifa**: compara o % de cada produto com a média do **próprio grupo** — frete% vs. média do mesmo tipo de logística (Full/Flex/Mercado Envios/Coleta), tarifa% vs. média da mesma conta. Nunca compara com a média GERAL (misturaria Full com Flex, que têm perfis de custo completamente diferentes, e geraria falso positivo). Flag só dispara com os dois critérios juntos: `valor > 1.5× a média do grupo` **e** `diferença > 3 pontos percentuais` — evita marcar como "anomalia" uma diferença de fração de ponto que é ruído, não sinal. Produto com faturamento 0 no período é ignorado do cálculo de médias e nunca recebe flag (divisão por zero).

## Drill-down de produto (`GET /api/bi/margem/produto/:itemId`, modal em `bi-margem-produtos.html`)

- **Série diária, não semanal** — diferente de `tendencia_semanal` (Visão Geral/tabela, 6 semanas), o modal de detalhe quer granularidade de dia pro gráfico e pra decomposição; janela padrão 60 dias (mínimo 60, mesmo que o filtro de período da tabela esteja em 7/14/30 — o drill-down sempre pede pelo menos 60 dias pra não ficar um gráfico com 2 pontos).
- **Decomposição em cascata** = a mesma fórmula de margem (`finance.md`) aplicada passo a passo: Venda → −Tarifa → −Frete do vendedor → −CMV → −Imposto → MC, somado no período inteiro (não por pedido individual).
- **Simulador de preço com % livre**: diferente das ações `REPRECIFICAR` (só 3 cenários fixos +3/+5/+10%), o modal deixa o analista digitar qualquer %. Calculado **100% no cliente** (sem round-trip) usando a mesma fórmula: `impacto = max(0, pct% × (faturamento − imposto − tarifa))` — tarifa/imposto escalam com o preço (são %), custo e frete do vendedor ficam fixos por unidade, volume constante. Precisa de `unit_price_atual`/`imposto_pct` do resumo do produto (únicos campos extras que a série de produto expõe além do que `produtos[]` já tem).
- **Ordenação de coluna na tabela de Produtos** é client-side (`SORT`/`aplicarOrdenacao`, `bi-margem-produtos.html`) — sem endpoint novo, já que os dados da página inteira (até milhares de linhas de portfólio) já vêm num único payload.
- **Modal de detalhe compartilhado** (`js/biMargemProdutoModal.js`): extraído de `bi-margem-produtos.html` na Fase C porque `bi-margem-portfolio.html` também precisava abrir o mesmo modal (clique num ponto da matriz) — nunca uma 2ª cópia da mesma lógica. O script se auto-instala (injeta HTML+CSS no `<body>`/`<head>` na primeira chamada) porque páginas estáticas sem build não têm como "incluir um componente" de outra forma; depende de `document.getElementById('imDays')`/`'imLoja'` (filtros da página que chamou) e da variável `DADOS` (`let` no topo do `<script>` de cada página — visível globalmente entre `<script>` clássicos do mesmo documento, não precisa de `window.DADOS`).

## Matriz de portfólio e cenário de mix (`bi-margem-portfolio.html`)

- **Matriz** (scatter/bubble, Chart.js): eixo X = volume (unidades vendidas, `qtd`), eixo Y = MC%, raio do ponto = `4 + sqrt(faturamento/faturamentoMáximo)×16` (proporcional à raiz do faturamento, não linear — evita que 1 produto muito maior que os outros esmague visualmente o resto). Cor por classificação (mesma paleta da tabela de Produtos). Clicar num ponto abre o modal de detalhe compartilhado (acima).
- **Cenário de mix** (`renderCenarioMix()`, 100% client-side sobre `DADOS.produtos` já carregado — sem endpoint novo): simula deslocar N pontos percentuais do faturamento TOTAL de anúncios com MC < 15% pra anúncios com MC ≥ 30%, mantendo:
  - faturamento total constante;
  - a MC% média de cada grupo (alta/baixa margem) constante — só a PARTICIPAÇÃO de cada grupo no faturamento muda;
  - o grupo "resto" (MC entre 15% e 30%) intocado.
  - **Limitado ao que hoje existe em baixa margem** — pedir 50 p.p. de deslocamento quando só há 27,8% do faturamento em baixa margem usa 27,8% (não inventa faturamento negativo) e mostra aviso explícito de que o limite foi aplicado.
  - Premissa sempre visível na tela — é simulação, não previsão (mesmo princípio de "nunca inventar número" das ações recomendadas).

## Reconciliação automática de frete/tarifa (`financeReconciliationJob`, v82)

> Fonte de verdade dos critérios de "pendente" e "confirmado". Código em `server/src/financeService.js` (serviço, compartilhado com o botão manual) e `server/src/worker.js` (job, a cada 10min). Ver `workers.md` pra cadência/circuit-breaker e `api.md` pro endpoint manual.

- **"Pendente" = `orders.finance_synced = false`**, nunca `ml_fee = 0` ou `shipping_seller_cost = 0`. As duas colunas numéricas já nascem com `DEFAULT 0` desde sempre — 0 não distingue "a API confirmou que é zero" de "ninguém perguntou pra API ainda". `finance_synced` é o marcador dedicado (v82), só vira `true` depois de uma chamada real confirmando os dois lados.
- **"Confirmado" por lado, não em bloco**:
  - **Frete do vendedor**: confirmado quando `/shipments/:id/costs` responde com sucesso (o valor de `senders[].cost` é salvo, **mesmo que seja 0** — frete grátis de verdade é um resultado válido). Pedido **sem** `shipping.id` nenhum (sem envio associado) conta como frete **não aplicável** — confirmado sem chamar a API, não fica pendente esperando um envio que talvez nunca exista.
  - **Tarifa**: confirmada quando existe `order.payments[0].id` **e** `/collections/:id` responde com sucesso (upsert em `ml_payments`). Pedido **sem** pagamento registrado ainda no `/orders/:id` fica pendente — não é erro, só significa "o pagamento ainda não chegou", tenta de novo na próxima janela.
  - `finance_synced = frete confirmado AND tarifa confirmada`. Confirmar só 1 dos 2 não marca como sincronizado.
- **Nunca usar `gross_amount` nem o custo do `receiver`** de `/shipments/:id/costs` como frete do vendedor — só `senders[].cost` (somado se vier array). `gross_amount` é o frete total da etiqueta; `receiver.cost` é o que o comprador paga.
- **Idempotência**: toda atualização é `SET valor = <confirmado pela API>`, nunca `valor = valor + <novo>`. Rodar o job (ou o botão) 2× seguidas no mesmo pedido dá o mesmo resultado final — não duplica tarifa nem frete. O upsert de `ml_payments` é `ON CONFLICT (payment_id) DO UPDATE`, mesma garantia.
- **Backoff exponencial por tentativa**: `finance_sync_attempts` reseta a `0` em todo sucesso (`finance_synced=true`) e incrementa em toda tentativa que não confirmou os dois lados (erro OU confirmação parcial). A query do job só pega pedidos com `last_finance_sync_at IS NULL OR last_finance_sync_at < now() - LEAST(2^tentativas, 1440) minutos` — 1ª tentativa imediata, depois 2min, 4min, 8min... até um teto de 24h. Evita bater sem parar num pedido que genuinamente nunca vai ter tarifa (ex.: pagamento cancelado antes de aprovar).
- **Prioridade**: pedidos das últimas 24h antes de pedidos mais antigos (mesmo critério dentro de cada grupo: mais antigo primeiro) — o dashboard olha mais pra vendas recentes, mas o backlog antigo também é processado, só depois.
- **Lote de 50 por execução, a cada 10 min** — 300/hora de teto, suficiente pra não deixar backlog crescer sem virar uma rajada de chamadas à API.

## Vendas por Estágio — integração Rankeamento × Inteligência de Negócio (`GET /api/bi/rankeamento`, `bi-rankeamento.html`)

> Fonte de verdade dos estágios continua sendo `ranking_ads` (módulo Rankeamento, `rankeamento.md`) — esta tela só LÊ, nunca cria/edita estágio. Mesma fórmula de margem do resto do BI (`finance.md`).

- **Estágio da venda = estágio ATUAL do anúncio, sempre — nunca uma reconstrução histórica.** `ranking_ads` só guarda o timestamp de ENTRADA na fase atual (`started_at`/`ranqueado_em`/`monitoramento_started_at`/`recuperacao_started_at`); voltar pra `rankeando` **limpa** esses carimbos (`rankeamento.md`). Não existe log de "estágio em cada instante" no banco — reconstruir a partir dos 4 timestamps seria ERRADO pra qualquer anúncio que já ciclou mais de uma vez (o carimbo da fase anterior já foi apagado). Por isso: uma venda de 20 dias atrás aparece com o estágio de HOJE do anúncio, não o de quando foi vendida — decisão consciente pra não inventar histórico que o banco não tem (ver `decisions.md`).
- **Vínculo venda→estágio**: `orders.item_id` → `ranking_ads.ml_id` (direto) OU `ranking_ad_links.ml_id` → `ranking_ad_links.ranking_ad_id` → `ranking_ads.id` (vínculo de catálogo, mesma regra de `rankeamento.md` "Vínculo tradicional ↔ catálogo"). Função única `ranking.buscarFasePorItemIds()`, usada tanto pela tag em `bi-vendas.html` quanto pelo agregado desta tela — nunca 2 cópias do join.
- **`sem_rankeamento`** é um bucket próprio (não um erro nem um item descartado) — a maioria dos anúncios do catálogo nunca foi marcada no módulo Rankeamento (ele é opt-in, `MAX_ADS=30` ativos). Fica de fora dos "4 blocos de estágio" (não é um estágio de processo) mas aparece na tabela de comparação completa, pra os totais não mentirem.
- **Comparação "hoje vs. média 7 dias"** usa os **últimos 7 dias FECHADOS** (hoje−7 até ontem), não incluindo hoje (parcial/em andamento) — evita comparar um dia incompleto com uma média que o inclui.
- **Conversão** (`conversao_pct` = pedidos ÷ visitas do bucket) usa `item_visits` (dado real, diário, por item) — **`null` quando não há visita cadastrada pro bucket, nunca `0` forçado** (0% de conversão é uma afirmação falsa quando na verdade não há dado). Frontend mostra "Dados insuficientes".
- **Fora do padrão** (`produtos_por_estagio[].fora_do_padrao`): só calculado com **≥3 anúncios no mesmo estágio** (amostra menor não dá média confiável). `'abaixo'` = pedidos ≤ 40% da média do estágio; `'acima'` = pedidos ≥ 200% da média. Limiares fixos, documentados aqui, ajustáveis.
- **Recuperação — antes × depois**: só anúncios ATUALMENTE em `fase='recuperacao'`, usando o ÚNICO carimbo confiável (`recuperacao_started_at`). "Antes" = vendas nos 14 dias fechados imediatamente anteriores à entrada, convertido em vendas/dia (÷14). "Depois" = vendas desde a entrada, convertido em vendas/dia (÷dias decorridos, mínimo 1). Janelas de tamanho diferente por design — comparar vendas/dia (taxa), não total bruto, é o que torna os dois lados comparáveis. **Linguagem sempre de efeito OBSERVADO, nunca causal** ("vendas/dia foram de X pra Y depois de entrar em recuperação" — nunca "a recuperação causou X") — mesmo princípio de `§14`/`§15` do pedido original.
- **Score por estágio** (`visao_executiva.score`): reusa as MESMAS funções de sub-score da Saúde do Negócio (`scoreRentabilidade`/`scoreCrescimento`/`percentil`, `routes/bi.js`) — nunca uma 2ª fórmula. 4 sub-scores de peso igual: volume (percentil de pedidos entre os 4 estágios), rentabilidade (MC%), crescimento (variação de faturamento vs. média 7d), estabilidade (% de dias do período com pelo menos 1 venda naquele estágio). Só os 4 estágios reais entram no ranking de score — `sem_rankeamento` não é um estágio de processo.
- **Insights automáticos são texto templated determinístico**, não LLM — mesmo princípio das ações recomendadas de margem: nunca inventar causa, só descrever o que os números já mostram (estágio líder, maior alta/queda vs. média 7d, MC acima da média geral).
