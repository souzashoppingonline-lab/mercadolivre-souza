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

## "Nova venda!" — quando notificar

Uma notificação Telegram de nova venda só dispara na **transição real** de status para `paid` (`previousStatus !== 'paid' && order.status === 'paid'`). Um webhook tardio de `shipments`/`payments` que reprocessa um pedido já pago não gera notificação duplicada. Syncs agendados (`syncVendas`) chamam `handleOrder` com `silent: true` para nunca notificar em reconciliação retroativa.

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
