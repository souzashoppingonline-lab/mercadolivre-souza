# Conciliação Bancária

> Escopo: o módulo financeiro que rastreia o ciclo Pedido → Pagamento → Liberação → Transferência → Conciliação. Para OAuth/rate limit do Mercado Livre em geral, ver `mercadolivre.md`. Para o schema das tabelas, ver `database.md`. Para os jobs agendados, ver `workers.md`.

## Status: Fase 1 implementada — Pedido, Pagamento e Liberação já funcionam com um único OAuth (Mercado Livre)

Pedido do usuário: reproduzir a experiência de um relatório financeiro de conciliação (referência: vídeo de um painel Mercado Pago), rastreando cada venda desde o pedido até o dinheiro efetivamente cair na conta. Investigação feita ao vivo contra a API de produção (não só leitura de doc) antes de desenhar o schema — ver `decisions.md` ("Conciliação Bancária — Fase 1").

## Descoberta principal: `/collections/:id` já traz o ciclo financeiro completo

A suposição inicial era que **Liberação** (`money_release_date`) e **valor líquido recebido** exigiam credencial de uma aplicação Mercado Pago separada (domínio `api.mercadopago.com`, OAuth próprio). **Isso estava errado.** `GET /collections/:id` (endpoint do domínio `api.mercadolibre.com`, mesmo token OAuth do app ML que já está em uso, endpoint que `handlePayment` já chamava desde sempre só pra extrair `order_id`) já retorna, confirmado ao vivo em produção (18/07/2026):

```
money_release_date, released ("no"/"yes"), net_received_amount,
mercadopago_fee, marketplace_fee, discount_fee, coupon_fee, finance_fee,
shipping_cost, payment_method_id, payment_type, installments, amount_refunded
```

**Consequência**: o módulo não precisa de uma segunda integração (app Mercado Pago com client_id/secret próprios) pra cobrir Pedido → Pagamento → Liberação — um único OAuth (o do Mercado Livre) resolve. Isso simplifica a arquitetura: 1 token, 1 fluxo de refresh, 1 fonte de verdade, sem risco de inconsistência entre duas integrações.

```
Orders API → order.payments[].id → GET /collections/:id → money_release_date / net_received_amount / released / taxas
```

`collection_id` e `payment_id` são o **mesmo número** (confirmado: `order.payments[0].id` bate exatamente com o `id` retornado por `/collections/:id`) — não há coluna separada pra isso.

## O que já funciona (Fase 1, deployado)

- **`ml_payments`** (v29/v30/v31) — `handlePayment` (`worker.js`) persiste o retorno completo de `/collections/:id` a cada webhook `payments`: status, valor bruto/líquido, `money_release_date`, `released`, taxas detalhadas, forma de pagamento. Só dados novos a partir do deploy — **sem backfill de pagamentos antigos** (pedido explícito do usuário).
- **Job `sync-payment-releases`** (05:15 diário, `worker.js`) — reconsulta até 200 pagamentos com `released != 'yes'`, priorizando `money_release_date` mais próxima. Necessário porque a transição pra liberado acontece semanas depois (~28 dias observado ao vivo) e não necessariamente gera um novo webhook `payments` do Mercado Livre — sem esse job, `released` ficaria travado em `'no'` mesmo depois do dinheiro cair de verdade.
- **`ml_billing_charges`** (v29) — cobrança oficial de tarifa (comissão, Ads, Full, taxa de disponibilidade antecipada, etc.), vinda da API de Relatórios de Faturamento (`GET /billing/integration/monthly/periods` + `.../details`, mesmo token ML). Job `syncBillingCharges` (a cada 30 min) lê só o período em aberto atual de cada loja/grupo (`ML` e `MP`), nunca período fechado/histórico. Serve pra **auditar** `orders.ml_fee` contra o valor oficial cobrado — é o lado "quanto devo de tarifa", complementar (não substitui) o `net_received_amount` de `ml_payments`.

## O que ainda não está confirmado/implementado

- **Transferência bancária** (repasse do saldo Mercado Pago pra conta bancária, agrupando N pagamentos numa única transferência) — nenhum campo observado até agora (nem em `/collections/:id`, nem na API de Faturamento) cobre isso. Pode exigir mesmo um endpoint específico do Mercado Pago (extrato/saque da carteira) — ainda não testado, porque não é bloqueante pra mostrar "liberado" (já temos `released`/`money_release_date`), só pra saber em qual lote bancário específico o valor saiu.
- **Webhooks Mercado Pago dedicados** (`payment`/`merchant_order`/chargebacks, com assinatura HMAC) — não configurados. Hoje a atualização depende do webhook `payments` do Mercado Livre (evento) + do job diário de reconsulta (para o caso `released` mudar sem novo webhook). Se isso se mostrar insuficiente em produção (ex: liberação não refletida a tempo), webhook MP dedicado vira alternativa — mas não é pré-requisito pro que já está no ar.
- **Chargebacks/estornos por pagamento** — `amount_refunded`/`refunds[]` existem no payload (`refunds` veio vazio em toda amostra observada), campo já capturado (`amount_refunded`), mas nenhum chargeback real foi observado ainda pra confirmar o formato completo de disputa.
- **Página frontend** (`pages/conciliacao-bancaria.html`) — ainda não criada; decisão do usuário foi backend/pipeline primeiro. Com `ml_payments` já rico o suficiente, a grid principal (Pedido/Payment/Liberação/Líquido/Taxas/Status) já pode ser construída sem esperar mais nada.
- **Agenda de Recebimentos** (agrupamento hoje/amanhã/7 dias/30 dias por `money_release_date`) — vira uma query de agregação simples sobre `ml_payments`, ainda não implementada.
- **Conciliação automática** (bater valor esperado × recebido × data) — lógica ainda não escrita; agora que `ml_payments.net_received_amount`/`released` existem, é viável construir sem depender de mais nenhuma API nova.

## API de Relatórios de Faturamento — resumo (detalhe completo já estava aqui antes desta correção)

- `GET /billing/integration/monthly/periods?group={ML|MP}&document_type=BILL&limit=N` — `document_type` obrigatório (confirmado: `422` sem ele). Retorna períodos mensais com `period_status` (`OPEN`/`CLOSED`).
- `GET /billing/integration/periods/key/{KEY}/group/{ML|MP}/details?document_type=BILL&limit=N` — linhas de cobrança individuais. Volume real observado: **857 a 10.381 linhas num mês, numa loja só** — API avisa contra chamada em massa/paralela; `syncBillingCharges` só lê a página 1 do período aberto, idempotente via `ON CONFLICT (detail_id) DO NOTHING`, nunca varre histórico.
- Campos `sales_info`/`shipping_info`/`items_info` de cada linha de cobrança vieram `null` em toda amostra (tarifas de conta, não atreladas a 1 venda) — `ml_billing_charges` não tem coluna `order_id` propositalmente até isso ser confirmado com uma tarifa de comissão de venda real.

## Lição registrada (ver `decisions.md` para o texto completo)

A hipótese inicial ("Liberação exige app Mercado Pago") foi proposta por mim sem testar `/collections/:id` por completo — só extraía `order_id` dele havia sessões inteiras. O usuário (via sugestão externa) pediu pra verificar antes de criar credencial nova, o teste ao vivo provou a hipótese errada. Reforça a disciplina já em uso nesta sessão: testar contra o sistema real antes de concluir que uma integração nova é necessária, mesmo quando a leitura de documentação pública sugere o contrário.
