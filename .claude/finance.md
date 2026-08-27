# Financeiro

> Escopo: como o sistema calcula margem, custo e ROI, e o formato/mapeamento da planilha Vendas ML Turbo. Para a regra de "por que o Turbo é a fonte oficial" ver `business-rules.md` (aqui só a mecânica de cálculo). Para o schema das tabelas envolvidas ver `database.md`. Para os endpoints ver `api.md`.

## Duas fontes de dado financeiro — não são a mesma coisa

| | `orders` (webhook-driven) | `ml_turbo_sales` (planilha) |
|---|---|---|
| Origem | Payload do webhook `orders_v2`/`payments`, reconstruído campo a campo | Export oficial do Mercado Turbo (Excel/CSV), importado manualmente |
| Atualização | Tempo real | Manual, sob demanda (upload) |
| Tarifa ML | `orders.ml_fee` = `item.sale_fee` do payload — pode ficar desatualizada/incompleta em pedidos com múltiplas taxas | `ml_turbo_sales.ml_fee` — valor já consolidado pelo ML |
| Imposto | Calculado no momento da consulta: `total_amount * stores.imposto_pct / 100` (percentual manual por loja) | Vem pronto na planilha (`tax`), já calculado pelo ML por pedido |
| Custo do produto | `items.cost` (editável manualmente) ou `sku_costs.cost` | `ml_turbo_sales.cost` (vem na planilha, se a planilha tiver a coluna preenchida) |
| Uso recomendado | Dashboards operacionais em tempo real, alertas | Fechamento financeiro, análise de margem confiável, relatórios para o `analisar-vendas` skill |

## Fórmula de margem — pedidos webhook-driven (`orders`)

Usada em `GET /api/vendas/detalhado`, `GET /api/vendas/hoje`, `GET /api/vendas/hoje-vs-ontem`, `GET /api/pedidos/:id/detalhes`:

```
custo        = items.cost × quantity
imposto      = total_amount × (stores.imposto_pct / 100)
tarifa       = mp_fee_amount (Conciliação) — fallback orders.ml_fee
frete_comprador = orders.shipping_cost
frete_vendedor  = shipping_fee_amount (Conciliação) — fallback orders.shipping_seller_cost

margem  = total_amount − custo − imposto − tarifa − frete_comprador − frete_vendedor
mc_pct  = margem / total_amount × 100
```

**Exceção — vendas Flex não pagam imposto por padrão** (`calcularMargemLinha`, `vendaMargem.js`; flag geral `imposto_flex_ativo` em `app_config`, ver `business-rules.md`): quando `shipping_type='self_service'` (Flex) e a flag está desligada (padrão do sistema), `imposto=0` nessa linha, independente do `imposto_pct` da loja — motivo: vendas Flex não têm nota fiscal emitida. **Escopo da flag**: só os consumidores de `calcularMargemLinha` a respeitam — `GET /api/vendas/detalhado` (Resumo por Venda, inclusive o card de totais), `GET /api/bi/margem*` (Inteligência de Margem, Vendas por Estágio) e `POST /api/vendas/:orderId/atualizar`/`financeReconciliationJob`. `GET /api/vendas/hoje`, `/vendas/hoje-vs-ontem`, `/pedidos/:id/detalhes` e os relatórios de `reports.js` calculam imposto **direto em SQL própria**, sem passar por `calcularMargemLinha` — continuam cobrando imposto de Flex sempre, decisão explícita do usuário de não estender a flag pra lá nesta tarefa (ver `known-bugs.md`).

### Precedência da taxa por pedido (Tarifa + Frete Vendedor) — `/vendas/detalhado` e `/vendas/margem`

Ambas calculam a taxa **por pedido** (`LEFT JOIN LATERAL` por `order_id`, some por loja/status depois) nesta ordem:

0. **Edição manual** (`orders.tarifa_manual`, v84) — vence TODAS as fontes abaixo, inclusive quando há Conciliação disponível. Botão ✏️ no card "Resumo por Venda" (`bi-vendas.html`), escape hatch pra quando nenhuma fonte automática acerta. `NULL` (padrão) = sem edição, segue a precedência normal.
1. **Conciliação Bancária** (`mp_account_movements`, `description='Payment'`, índice `idx_mp_mov_order`) — fonte oficial das 05:40, **separa** `mp_fee_amount` (Tarifa) de `shipping_fee_amount` (Frete Vendedor). **Proteção contra frete do comprador vazando pra tarifa** (`CONCILIACAO_TARIFA_LATERAL`, `vendaMargem.js`, bug real reportado pelo usuário — ver `business-rules.md`): quando um pedido tem mais de 1 linha `'Payment'` na Conciliação, uma delas pode ser o repasse do frete pago pelo comprador com o valor inteiro caindo em `MP_FEE_AMOUNT` (nada em `SHIPPING_FEE_AMOUNT`) — detectada e excluída da soma quando bate exatamente com `orders.shipping_cost` daquele pedido. Pedido de 1 linha só (o caso comum) nunca é tocado. Se essa proteção não cobrir um caso, a edição manual (item 0) resolve sem precisar mexer em código.
2. **`ml_payments`** (webhook `payments`, tempo real, por venda) — `taxa = transaction_amount − net_received_amount`, **só conta quando `> 0`** (`status='approved'`, `net_received_amount` não nulo; a LATERAL faz `NULLIF(GREATEST(...,0),0)`). Pagamento em `account_money` às vezes registra `taxa=0` no payment (a comissão é cobrada por fora) — nesse caso **não** usa esta fonte, cai direto no item 3 (`ml_fee`+`shipping_seller_cost`), senão zeraria tarifa **e** frete indevidamente. Quando `taxa > 0`, é o **total** ML descontado (comissão + frete juntos); como o ML não separa, a rota **separa usando o `shipping_seller_cost`**: **Frete Vendedor = LEAST(shipping_seller_cost, taxa)** e **Tarifa = taxa − esse frete** (o `LEAST` impede tarifa negativa). Soma tarifa+frete = `taxa`, então **a Margem/MC% fica idêntica** — muda só o rótulo, e a coluna Frete Vendedor deixa de vir zerada. Cobre a venda nova antes do relatório das 05:40 chegar.
3. **`orders.ml_fee` / `orders.shipping_seller_cost`** — `ml_fee`=`item.sale_fee` gravado no ato do pedido (pode vir 0 num pedido recém-criado, o ML corrige depois); `shipping_seller_cost` é populado em tempo real pelo `handleShipment` via `/shipments/:id/costs` (`senders_cost`).
4. Nada → 0.

Cada linha do `/detalhado` traz `fonte_taxa` (`conciliacao`|`pagamento`|`pedido`) e `tem_conciliacao`; os totais/lojas trazem `pedidos_conciliados` (pedidos com taxa real, fonte 1 **ou** 2). Na fonte `pagamento`, a coluna Frete Vendedor mostra o `shipping_seller_cost` (separado da Tarifa via `LEAST`, item 2 acima) e só fica 0 se o frete ainda não foi sincronizado — a Margem bate igual nos dois casos. Ver `conciliacao-bancaria.md`.

**Modal de detalhes (`GET /api/pedidos/:id/detalhes`) usa a MESMA precedência** dos itens 1-3 (mesmas LATERALs de Conciliação/`ml_payments`), então Tarifa/Frete/Margem/MC% do modal batem **1:1** com a linha da tabela. Antes o modal usava só `ml_fee`+`shipping_seller_cost` crus e divergia (ex.: pedido `account_money` com `taxa=0` na tabela vs. `ml_fee` no modal). O input "Frete Vendedor" do modal continua editável e mostra o `shipping_seller_cost` cru (o que é gravado); a linha "Frete Vendedor" do bloco Financeiro mostra o `freteVend` **calculado** pela precedência. As demais rotas de leitura ainda usam só os campos do pedido.

`GET /api/vendas/diarias` usa uma **aproximação diferente e mais simples**, sem custo real por pedido: `liquido = bruto × 0.88` e `taxas = bruto × 0.12` — é uma estimativa grosseira para gráfico rápido, não usar como referência de margem real.

## Margem de Contribuição por loja — reproduz o Mercado Turbo (`GET /api/vendas/margem`)

Página **Vendas por Loja**. Fórmula idêntica à do Mercado Turbo (validada contra os dois números reais das lojas Ricopi e Unifull):

```
aprovadas       = SUM(total_amount) onde status <> 'cancelled'
custo           = items.cost × quantity
imposto         = total_amount × (stores.imposto_pct / 100)
tarifa          = mp_fee_amount        (Conciliação MP) — fallback orders.ml_fee
frete_vendedor  = shipping_fee_amount  (Conciliação MP) — fallback 0

margem  = aprovadas − custo − imposto − tarifa − frete_vendedor   [− frete_comprador só se ?frete_comprador=1]
margem_pct = margem / aprovadas × 100
```

Diferença-chave para a fórmula de `orders` acima: **tarifa e frete do vendedor NÃO saem do pedido** (o worker nunca populou `shipping_seller_cost` de verdade — sempre 0). Saem da **Conciliação Bancária** (`mp_account_movements`, `description='Payment'`, casado por `order_id`), que é a mesma fonte que o Mercado Turbo usa — o relatório de liberações do Mercado Pago. Sem relatório no período, `tem_conciliacao=false` e a tarifa cai para `orders.ml_fee`.

**Por que a tarifa não é % fixo:** a tarifa do ML = comissão (% por categoria/tipo de anúncio, ~11–19%) **+ custo fixo por unidade** para itens abaixo de um limiar de preço. Por isso não se estima por percentual — usa-se o valor real cobrado (`mp_fee_amount`), que já soma comissão + fixo.

**Frete do comprador** só é abatido com o toggle `frete_comprador=1` (padrão desligado, igual ao Turbo: frete que o comprador paga não é custo do vendedor).

## Fórmula de margem/ROI — planilha Turbo (`ml_turbo_sales`)

A margem (`margin`, `margin_pct`) já vem calculada na própria planilha exportada pelo ML — o sistema não recalcula, só agrega (`SUM(margin)`, `SUM(margin)/SUM(revenue)*100`).

ROI (`GET /api/turbo/kpis`):
```
custos_totais = cmv + ads + impostos + tarifas + frete_vendedor
roi = (lucro / custos_totais) × 100
```
Nota: `frete_comprador` **não entra** no denominador do ROI (é repassado pelo comprador, não é custo do vendedor).

## Upload da planilha — mapeamento de colunas (`routes/turbo.js`)

O parser não assume nomes de coluna fixos: normaliza cada header (minúsculas, sem acento, sem pontuação) e casa contra uma lista de aliases por campo (`COL_MAP`), testando exact match → starts-with → includes, nessa ordem. Também autodetecta em qual das 5 primeiras linhas está o cabeçalho real (a planilha do Mercado Turbo às vezes tem linhas de título antes do header). Se a coluna "ID da Venda" não for identificada, a importação falha com a lista de headers detectados para diagnóstico.

Campos mapeados: `sale_id`, `cart_id`, `buyer`, `state`, `item_code`, `title`, `account`, `shipping_mode`, `ads`, `sku`, `sale_date`, `shipping_type`, `unit_price`, `quantity`, `revenue`, `cost`, `tax`, `ml_fee`, `buyer_shipping`, `seller_shipping`, `margin`, `margin_pct`, `order_status`, `payment_status`, `shipping_id` — descrição de cada um em `database.md` (tabela `ml_turbo_sales`).

Upsert por `sale_id` (chave `UNIQUE`) — reimportar a mesma planilha atualiza os registros existentes em vez de duplicar.

## Classificação de vendas aprovadas/canceladas/devolvidas (Turbo)

`GET /api/turbo/kpis` classifica por `order_status ILIKE`:
- **Cancelada**: contém "cancel".
- **Devolução**: contém "devol", "return" ou "restitu".
- **Aprovada**: qualquer status que não seja nenhum dos dois acima.

Não há uma lista fechada de status possíveis — a classificação é por substring porque o texto de `order_status` vem literal da planilha (varia entre exports).

## Custo por SKU vs. custo por item

`sku_costs` guarda custo por `sku` (compartilhado entre lojas — útil quando o mesmo produto é vendido em contas diferentes com o mesmo código interno). Ao salvar via `PATCH /api/custos/:sku`, o valor também é gravado em `items.cost` **usando `sku` como se fosse `ml_id`** — ou seja, esse endpoint só funciona corretamente hoje se o "SKU" usado for exatamente o `ml_id` do anúncio (não há coluna `sku` própria em `items`). Ver `known-bugs.md`.
