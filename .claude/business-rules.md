# Regras de Negócio

> Escopo: comportamento de domínio que não é óbvio olhando só a assinatura de uma função — thresholds, definições, e por que o sistema decide X e não Y. Regras puramente financeiras (fórmula de margem, ROI) estão em `finance.md` para não duplicar. **Sempre que uma nova regra de negócio for descoberta ou definida, registre aqui.**

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

## Notificações Telegram — regras de silêncio e throttle

Cada tópico (`tg_vendas`, `tg_perguntas`, etc.) pode ser individualmente desativado em `app_config`. Além disso, globalmente:
- **Janela de silêncio**: nenhuma notificação via `tgNotify` (não `tgNotifyForce`) é enviada entre `silence_start` e `silence_end` (padrão 22:00–07:00, horário local do processo).
- **Intervalo mínimo por tópico**: `tg_interval` (minutos) — se >0, um mesmo tópico não pode notificar de novo antes desse intervalo, mesmo com múltiplos eventos.
- **Notificações que ignoram tudo isso** (`tgNotifyForce`): resultado dos syncs agendados (`tg_infra`) e o resumo diário (`tg_resumo`) — são consideradas relatórios operacionais, não alertas em tempo real.
- **Rate limit de alertas de rate limit**: `track429` só notifica `tg_429` depois de 3 cooldowns de 429 na mesma loja em uma janela de 10 min, e depois espera outros 10 min antes de notificar de novo — evita spam de alerta quando a API do ML está instável.

## Vendas ML Turbo é a fonte financeira "oficial"

A tabela `orders` (webhook-driven) é usada para tudo que é operacional em tempo real (dashboard, pedidos, análises temporais). Mas o **cálculo financeiro definitivo** (margem, ROI, custos completos) é feito a partir da planilha importada em `ml_turbo_sales`, não a partir de `orders` — porque a planilha do Mercado Turbo já vem com tarifas, impostos e fretes exatos calculados pelo próprio ML, enquanto `orders` reconstrói esses valores a partir de campos parciais do payload do webhook (ver `finance.md` para as duas fórmulas lado a lado).

## Detecção de coluna "conta" (loja) na planilha Turbo

O campo `account` no upload da planilha (`ml_turbo_sales.account`) é texto livre, sem chave estrangeira para `stores.id` — é o nome da conta como aparece na coluna "Conta"/"Loja"/"Vendedor" da planilha exportada pelo Mercado Turbo. Isso significa que corrigir o nome de uma loja depois de importar não atualiza vendas já importadas — é preciso reimportar a planilha. Mapeamento de aliases de coluna documentado em `finance.md`.
