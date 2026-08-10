# Cartão de crédito — por que a tabela de Boletos mostra a FATURA e não as parcelas

> Escopo: como as compras no cartão aparecem na tela **Boletos** (`pages/financeiro-boletos.html`) e por que elas viram uma **fatura virtual** em vez de N linhas de parcela. A gestão detalhada (parcela a parcela, tags, limites) fica no **Relatório de Cartão** (`pages/financeiro-cartoes.html`). Tabelas envolvidas: `boletos_mensais`, `parcelas_cartao`, `cartoes`, `fatura_pagamentos`.

## A ideia central

O sistema imita como um cartão de crédito funciona na vida real: **ninguém paga parcela individual — paga-se a fatura do mês**, que junta todas as compras daquele ciclo. Por isso a compra parcelada não aparece linha a linha na tabela de contas a pagar; ela vira **uma fatura por cartão por mês**.

## O que acontece ao cadastrar uma compra no cartão

Exemplo: **R$ 1.200 em 12× no Nubank**.

1. **1 INSERT em `boletos_mensais`** (a "compra-mãe"):
   - `tipo = 'cartao'`
   - `is_origem = true`
   - `value = 1200,00` (valor **total** da compra)
   - `cartao_id`, `numero_parcelas = 12`, `valor_total = 1200`, `data_compra`, `date = vencimento da 1ª parcela`
2. **12 INSERTs em `parcelas_cartao`** (uma por parcela):
   - `divida_id = id da compra-mãe`, `numero_parcela = 1..12`, `valor = 100,00`, `status = 'pendente'`
   - `data_vencimento` e `fatura_mes` calculados pela **regra de cartão** (ver `calcVencimentos` na página): compra **até** o dia de fechamento → 1ª parcela na fatura do mês da compra, vence no mês seguinte; **depois** do fechamento → começa na fatura do mês seguinte.

## A "mágica" na tabela de Boletos

1. **Esconde as compras-mãe de cartão** da tabela:
   ```js
   const boletosVis = boletosMes().filter(b => b.tipo !== 'cartao');
   ```
2. **Cria faturas virtuais** — para cada cartão ativo, soma as `parcelas_cartao` que vencem no **mês selecionado** (`fatura_mes`) e gera **uma** linha representando a fatura (`faturasMes()` na página):
   ```js
   // 1 linha por cartão: value = soma das parcelas do mês, status derivado
   { _fatura:true, cartao_id, name: cartao.nome, value: totalDoMes, count, pendentes, status }
   ```
3. **A tabela é a junção**: `[...boletosVis, ...faturasVirtuais]` ordenada por vencimento.

Visualmente:

```
Vencimento  Tipo     Descrição     Valor       Status
05/08       Boleto   Aluguel       R$ 3.500    Pendente
10/08       Boleto   Internet      R$ 299      Pendente
15/08       Cartão   Nubank        R$ 850      [Pagar Fatura]   ← FATURA VIRTUAL
20/08       Imposto  DAS           R$ 1.200    Pendente
```

A linha "Nubank — R$ 850" **não é uma compra real**: é a fatura virtual que agrupa, por exemplo, parcela 3/12 do iPhone (R$100) + 5/10 do sofá (R$250) + 2/6 da viagem (R$500).

## Pagar a fatura

Ao clicar em **Pagar Fatura** (`pagarFaturaCartao(cartaoId)`), o sistema, para o cartão + mês selecionados:
1. Marca **todas as parcelas pendentes** daquele mês como `pago` (`UPDATE parcelas_cartao`).
2. Registra o pagamento em **`fatura_pagamentos`** (`cartao_id`, `fatura_mes`, `data_pagamento`, `valor_pago`, `parcelas_count`) para histórico.
3. *(no Readdy original: também lança a saída no Fluxo de Caixa, agrupado por empresa — ver "pendências" abaixo).*

```sql
-- quita todas as parcelas do mês de uma vez
UPDATE parcelas_cartao SET status='pago'
 WHERE cartao_id = :cid AND fatura_mes = :mesSelecionado AND status='pendente';
```

## Como tudo se conecta

```
boletos_mensais (tipo='cartao', is_origem=true)   ← compra-mãe, ESCONDIDA da tabela
  └─ parcelas_cartao (N registros)
       ├─ 1/12 → fatura_mes=2026-02 → R$100
       ├─ 2/12 → fatura_mes=2026-03 → R$100
       └─ ...
Na tabela de 2026-02:  [ Cartão | Nubank | R$ soma-das-parcelas | Pagar Fatura ]
Detalhe parcela a parcela → aba "Relatório de Cartão".
```

## Por que esse design

1. **Espelha a realidade** — paga-se a fatura mensal, não a parcela.
2. **Evita poluição visual** — 12 linhas por compra parcelada viraria bagunça.
3. **Pagamento em lote** — um clique quita a fatura inteira do mês.
4. **Detalhamento separado** — o drill-down por parcela vive no **Relatório de Cartão**.

## Efeito nos totais/KPIs

Como a compra-mãe (`value = total`) e as `parcelas_cartao` coexistem, **somar os dois dobraria o valor**. Por isso, KPIs / contador / total da tabela **excluem `tipo='cartao'`** de `boletos_mensais` e somam as **faturas virtuais** (parcelas do mês). Regra: o valor de cartão que entra no mês é sempre o das **parcelas daquele `fatura_mes`**, nunca o `value` da compra-mãe.

## Pendências conhecidas (v1)

- **Sincronização com Fluxo de Caixa** ao pagar a fatura (INSERT em `cash_flow_entries`) ainda não implementada aqui — por isso o filtro/label "Lançado FC" do Readdy foi omitido.
- **Escolher a conta bancária** de saída no pagamento da fatura ainda não é pedido.
- **Edição inteligente** da compra de cartão (preservar parcelas já pagas, só mexer nas pendentes; aumentar/diminuir nº de parcelas) e **exclusão de compra** (DELETE `parcelas_cartao` + `cash_flow_entries` + `boletos_mensais`) ainda não implementadas na tela Boletos — a gestão de parcelas está no Relatório de Cartão.
- Resumo por Empresa e Calendário de Vencimentos ainda contam boletos comuns; a atribuição de parcelas de cartão por empresa (via compra-mãe) é um refinamento futuro.
