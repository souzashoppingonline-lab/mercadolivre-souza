# 🧠 MEMÓRIA DO BANCO SUPABASE — ERP Financeiro Multi-Empresa

> **Projeto**: ERP financeiro com controle de boletos, fluxo de caixa, compras/CMV, vendas, cartões de crédito, conciliação bancária, e-commerce, Mercado Livre, tarefas e projeções financeiras.
> **Stack**: React 19 + TypeScript + TailwindCSS + Supabase (PostgreSQL)
> **Empresas**: UNIFULL, TOP MIX, R SOUZA (3 CNPJs distintos gerenciados no mesmo sistema)
> **Lojas (stores)**: UNIFULL, TOP MIX, R SOUZA, SHOPEE
> **⚠️ Regra**: Quase toda tabela tem `store_id` (uuid, nullable) como chave de multi-tenancy. Sempre filtrar por `store_id` quando relevante.

---

## 🏢 EMPRESAS CONFIGURADAS

| Key | Nome | Cor Tailwind (badge) |
|-----|------|---------------------|
| `UNIFULL` | UNIFULL | `bg-sky-100 text-sky-700` |
| `TOP MIX` | TOP MIX | `bg-emerald-100 text-emerald-700` |
| `R SOUZA` | R SOUZA | `bg-amber-100 text-amber-700` |

**Arquivo**: `src/pages/compras-cmv/constants.ts` — constante `EMPRESAS`
**Uso**: Os campos `empresa` (text, nullable) em várias tabelas armazenam a key da empresa (ex: `'UNIFULL'`). Sempre usar `.trim()` ao comparar pois pode vir com espaços.

---

## 📦 TABELAS POR DOMÍNIO

---

## 1. CORE / CONFIGURAÇÃO

### `stores` — Lojas / CNPJs
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | Nome da loja (UNIFULL, TOP MIX, R SOUZA, SHOPEE) |
| `cnpj` | text | CNPJ |
| `nome_fantasia` | text | Nome fantasia |
| `razao_social` | text | Razão social |
| `banco_nome` | text | Banco |
| `banco_agencia` | text | Agência |
| `banco_conta` | text | Conta |
| `banco_tipo` | text | Tipo (default: 'corrente') |
| `ativa` | boolean | default true |
| `created_at` | timestamptz | |

### `system_settings` — Configurações chave-valor
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `key` | text PK | Chave da config |
| `value` | text NOT NULL | Valor |
| `updated_at` | timestamptz | |

---

## 2. USUÁRIOS & PERMISSÕES

### `users` — Usuários (tabela custom, NÃO é auth.users do Supabase)
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `email` | text NOT NULL | |
| `password_hash` | text NOT NULL | Senha hasheada |
| `name` | text NOT NULL | Nome do usuário |
| `role` | text NOT NULL | 'admin' ou 'user' |
| `is_active` | boolean NOT NULL | default true |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `user_permissions` — Permissões por usuário/página
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `user_id` | uuid NOT NULL | FK → users.id |
| `page_path` | text NOT NULL | Caminho da página (ex: '/boletos') |
| `can_access` | boolean NOT NULL | default true |
| `can_edit` | boolean NOT NULL | default false |
| `can_delete` | boolean NOT NULL | default false |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `access_logs` — Log de acessos
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `user_id` | uuid | FK → users |
| `user_email` | text NOT NULL | |
| `user_name` | text NOT NULL | |
| `action` | text NOT NULL | 'login', 'logout', etc |
| `ip_address` | text | |
| `user_agent` | text | |
| `created_at` | timestamptz | |

### `password_reset_tokens` — Tokens de reset de senha
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `user_id` | uuid NOT NULL | FK → users |
| `token` | text NOT NULL | |
| `expires_at` | timestamptz NOT NULL | |
| `used` | boolean NOT NULL | default false |
| `created_at` | timestamptz | |

---

## 3. BOLETOS & DÍVIDAS (MÓDULO PRINCIPAL)

### `boletos` — Tabela legada de boletos (em desuso, substituída por boletos_mensais)
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `category` | text NOT NULL | default 'Geral' |
| `name` | text NOT NULL | Descrição |
| `value` | numeric NOT NULL | default 0 |
| `status` | text NOT NULL | 'pendente', 'pago', 'atrasado' |
| `supplier` | text | Fornecedor |
| `is_recurring` | boolean | default false |
| `recurring_has_value` | boolean | default true |
| `recurring_group_id` | uuid | Grupo de recorrência |
| `store_id` | uuid | FK → stores |
| `created_at` | timestamptz | |

### `boletos_mensais` — ⭐ Tabela principal de dívidas mensais
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `id_recorrente` | uuid | FK → boletos_recorrentes (se gerado de template) |
| `name` | text NOT NULL | Descrição/título |
| `category` | text NOT NULL | Categoria |
| `supplier` | text | Fornecedor |
| `date` | date NOT NULL | Data de vencimento |
| `value` | numeric | default 0 |
| `status` | text | 'pendente', 'pago', 'atrasado' |
| `mes_referencia` | text NOT NULL | Formato 'YYYY-MM' |
| `numero_parcela` | integer | Nº da parcela (se parcelado) |
| `cartao_credito` | text | Nome do cartão (denormalizado) |
| `banco` | text | Nome do banco |
| **`empresa`** | text | ⭐ Key da empresa: 'UNIFULL', 'TOP MIX', 'R SOUZA' |
| `tipo` | text NOT NULL | 'boleto', 'manual' (imposto), 'cartao', 'pessoal', 'fatura_ml', 'flex', 'custo_fixo', 'custo_variavel' |
| `cartao_id` | uuid | FK → cartoes |
| `divida_id` | uuid | FK → boletos_mensais (dívida origem, se for parcela) |
| `is_origem` | boolean NOT NULL | true se for a dívida-mãe (não parcela) |
| `valor_total` | numeric | Valor total da compra |
| `numero_parcelas` | integer | Total de parcelas |
| `data_compra` | date | Data da compra |
| `store_id` | uuid | FK → stores |
| `created_at` | timestamptz | |

**Tipos de dívida**:
- `boleto` — Boleto bancário tradicional
- `manual` — Impostos/taxas
- `cartao` — Compra no cartão de crédito (gera parcelas)
- `pessoal` — Gastos pessoais
- `fatura_ml` — Fatura do Mercado Livre
- `flex` — Mercado Livre Flex
- `custo_fixo` — Custo fixo operacional
- `custo_variavel` — Custo variável

### `boletos_recorrentes` — Templates de dívidas recorrentes
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `nome` | text NOT NULL | Nome do template |
| `categoria` | text NOT NULL | |
| `fornecedor` | text | |
| **`empresa`** | text | ⭐ Key da empresa |
| `dia_vencimento` | integer NOT NULL | Dia do mês (1-31) |
| `ativo` | boolean | default true |
| `total_parcelas` | integer | Total de parcelas (se parcelado) |
| `parcela_atual` | integer | Parcela atual (default 0) |
| `valor_total` | numeric | Valor total |
| `cartao_credito` | text | |
| `banco` | text | |
| `tipo` | text | default 'boleto' |
| `store_id` | uuid | FK → stores |
| `created_at` | timestamptz | |

### `boleto_categories` — Categorias de boleto
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | Nome da categoria |
| `type` | text NOT NULL | 'categoria' |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `receivables` — Recebíveis / Contas a receber
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | Data prevista |
| `description` | text | |
| `value` | numeric NOT NULL | default 0 |
| `recebido` | boolean NOT NULL | default false |
| `data_recebimento` | date | Data que foi recebido |
| **`empresa`** | text | ⭐ Key da empresa |
| `store_id` | uuid | FK → stores |
| `created_at` | timestamptz | |

---

## 4. CARTÕES DE CRÉDITO

### `cartoes` — Cartões cadastrados
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `nome` | text NOT NULL | Nome do cartão |
| `bandeira` | text | Visa, Mastercard, etc |
| `dia_fechamento` | integer NOT NULL | Dia de fechamento (default 20) |
| `dia_vencimento` | integer NOT NULL | Dia de vencimento (default 10) |
| `cor` | text | Cor hex para UI (default '#64748b') |
| `ativo` | boolean NOT NULL | default true |
| `limite` | numeric | Limite do cartão |
| `store_id` | uuid | FK → stores |
| `created_at` | timestamptz | |

### `parcelas_cartao` — Parcelas individuais de compras no cartão
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `divida_id` | uuid NOT NULL | FK → boletos_mensais (dívida origem) |
| `numero_parcela` | integer NOT NULL | Nº da parcela |
| `data_vencimento` | date NOT NULL | |
| `valor` | numeric NOT NULL | default 0 |
| `status` | text NOT NULL | 'pendente', 'pago' |
| `fatura_mes` | text NOT NULL | Formato 'YYYY-MM' |
| `cartao_id` | uuid | FK → cartoes |
| `boleto_mensal_id` | uuid | FK → boletos_mensais |
| `tag_id` | uuid | FK → parcela_tags |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `parcela_tags` — Tags para parcelas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `nome` | text NOT NULL | |
| `cor` | text NOT NULL | default '#64748b' |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `fatura_pagamentos` — Histórico de pagamentos de fatura
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `cartao_id` | uuid | FK → cartoes |
| `fatura_mes` | text NOT NULL | Formato 'YYYY-MM' |
| `data_pagamento` | date NOT NULL | |
| `valor_pago` | numeric NOT NULL | |
| `parcelas_count` | integer NOT NULL | Quantas parcelas foram pagas |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 5. FLUXO DE CAIXA

### `cash_flow_entries` — Lançamentos do fluxo de caixa
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `type` | text NOT NULL | 'income' (entrada) ou 'expense' (saída) |
| `value` | numeric NOT NULL | default 0 |
| `store_id` | uuid | FK → stores |
| `category` | text | Categoria |
| `reason` | text | Motivo/descrição |
| `boleto_id` | uuid | FK → boletos_mensais (se veio de um boleto) |
| `created_at` | timestamptz | |

**Regra de sincronização**: Quando um boleto é marcado como PAGO, automaticamente:
1. Deleta qualquer entry existente com aquele `boleto_id`
2. Insere nova entry com `type='expense'`, `reason = nome + fornecedor`, `value = valor do boleto`

Quando volta pra PENDENTE, deleta a entry.

### `cash_flow_categories` — Categorias do fluxo de caixa
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `cash_flow_recurring` — Lançamentos recorrentes do fluxo
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `type` | text NOT NULL | 'income' ou 'expense' |
| `value` | numeric NOT NULL | |
| `category` | text | |
| `reason` | text | |
| `store_id` | uuid | |
| `day_of_month` | integer NOT NULL | Dia do mês |
| `active` | boolean NOT NULL | default true |
| `created_at` | timestamptz | |

### `manual_cash_flow_values` — Valores manuais de projeção
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `year` | integer NOT NULL | |
| `month` | integer NOT NULL | |
| `value` | numeric NOT NULL | |
| `bank_in` | numeric | Entradas bancárias manuais |
| `bank_out` | numeric | Saídas bancárias manuais |
| `store_id` | uuid | |
| `updated_at` | timestamptz | |

### `forecast_inflow_overrides` — Overrides de entradas na projeção
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `value` | numeric NOT NULL | |
| `type` | varchar | default 'inflow' |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `forecast_starting_balance` — Saldo inicial de projeção
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | integer PK (serial) | |
| `mes_ano` | text NOT NULL | Formato 'YYYY-MM' |
| `value` | numeric NOT NULL | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

## 6. COMPRAS & CMV

### `fornecedores_cmv` — Fornecedores
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `nome` | text NOT NULL | |
| `cnpj_cpf` | text | |
| `contato` | text | Telefone/email |
| `nome_contato` | text | Nome da pessoa de contato |
| `prazo_pagamento` | integer | default 30 (dias) |
| `lead_time_dias` | integer | default 7 |
| `categoria` | text | default 'atacadista' |
| `status` | text | default 'ativo' |
| `observacao` | text | |
| `alerta_dias_sem_contato` | integer | default 30 |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `compras_cmv` — Compras realizadas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `fornecedor_id` | uuid | FK → fornecedores_cmv |
| `data_compra` | date NOT NULL | |
| `data_entrada` | date | Data de entrada/entrega |
| `valor_total` | numeric | default 0 |
| `tipo_compra` | text | 'normal', etc |
| `observacao` | text | |
| `fornecedor_nome` | text | Nome do fornecedor (denormalizado) |
| `status_entrega` | text | 'pendente', 'entregue', etc |
| **`empresa`** | text | ⭐ Key da empresa |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `itens_compra_cmv` — Itens de cada compra
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `compra_id` | uuid | FK → compras_cmv |
| `produto_id` | uuid | FK → produtos_cmv |
| `quantidade` | numeric NOT NULL | |
| `custo_unitario_bruto` | numeric NOT NULL | |
| `imposto_unitario` | numeric | default 0 |
| `frete_rateado_unitario` | numeric | default 0 |
| `custo_final_unitario` | numeric | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `produtos_cmv` — Produtos / SKUs
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | Código SKU |
| `nome` | text NOT NULL | Nome do produto |
| `categoria` | text | |
| `unidade` | text | 'un', 'kg', 'lt', etc |
| `status` | text | 'ativo', 'inativo' |
| `custo_medio_atual` | numeric | Custo médio atual |
| `estoque_atual` | numeric | |
| `data_ultima_compra` | date | |
| `foto_url` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `historico_custo_cmv` — Histórico de custos
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `produto_id` | uuid | FK → produtos_cmv |
| `fornecedor_id` | uuid | FK → fornecedores_cmv |
| `compra_id` | uuid | FK → compras_cmv |
| `data_compra` | date NOT NULL | |
| `quantidade` | numeric NOT NULL | |
| `custo_unitario` | numeric NOT NULL | |
| `custo_final_unitario` | numeric NOT NULL | |
| `custo_medio_antes` | numeric | |
| `custo_medio_depois` | numeric | |
| `fornecedor_nome` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 7. VENDAS

### `sales_entries` — Registros de vendas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `quantity_sales` | integer NOT NULL | Qtd de vendas |
| `gross_revenue` | numeric NOT NULL | Receita bruta |
| `marketplace_fees` | numeric NOT NULL | Taxas do marketplace |
| `subsidized_shipping` | numeric NOT NULL | Frete subsidiado |
| `cogs` | numeric NOT NULL | Custo da mercadoria |
| `ads_ml` | numeric NOT NULL | Ads Mercado Livre |
| `ads_external` | numeric NOT NULL | Ads externos |
| `tax` | numeric NOT NULL | Impostos |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

**Margem de contribuição**: `gross_revenue - marketplace_fees - subsidized_shipping - cogs - ads_ml - ads_external - tax`

### `monthly_goals` — Metas mensais
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `month` | integer NOT NULL | Mês (1-12) |
| `year` | integer NOT NULL | Ano |
| `goal_value` | numeric NOT NULL | Valor da meta |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

## 8. DESPESAS & DRE

### `expenses` — Despesas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `type` | text NOT NULL | 'fixed' (fixa) ou 'operational' (operacional) |
| `description` | text NOT NULL | |
| `category_id` | uuid | FK → expense_categories |
| `value` | numeric NOT NULL | default 0 |
| `date` | date NOT NULL | |
| `is_recurring` | boolean NOT NULL | default false |
| `recorrencia_vezes_mes` | integer | default 1 — quantas vezes por mês a despesa recorrente ocorre (add. via MCP, migration `expenses_recorrencia_vezes_e_gasto_fixo`) |
| `gasto_fixo_mensal` | boolean | default false — marca como gasto fixo mensal garantido |
| `month` | integer NOT NULL | |
| `year` | integer NOT NULL | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `expense_categories` — Categorias de despesa
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 9. FECHAMENTO MENSAL

### `monthly_closing` — Fechamentos mensais consolidados
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `month` | integer NOT NULL | |
| `year` | integer NOT NULL | |
| `closed_at` | timestamptz | |
| `closed_by` | uuid | FK → users |
| `status` | text | 'closed' |
| `revenue_gross` | numeric | Receita bruta |
| `revenue_total` | numeric | Receita total |
| `cogs_total` | numeric | CMV total |
| `fixed_costs_total` | numeric | Custos fixos |
| `variable_costs_total` | numeric | Custos variáveis |
| `contribution_margin` | numeric | Margem de contribuição |
| `contribution_margin_pct` | numeric | Margem % |
| `ads_cost_total` | numeric | Ads total |
| `ads_ml` | numeric | Ads ML |
| `ads_external` | numeric | Ads externos |
| `total_sales` | integer | Qtd vendas |
| `avg_ticket` | numeric | Ticket médio |
| `cash_flow_in` | numeric | Entradas caixa |
| `cash_flow_out` | numeric | Saídas caixa |
| `cash_flow_balance` | numeric | Saldo caixa |
| `boletos_paid_count` | integer | Boletos pagos |
| `boletos_paid_total` | numeric | Total pago |
| `boletos_pending_count` | integer | Boletos pendentes |
| `boletos_pending_total` | numeric | Total pendente |
| `expense_categories` | jsonb | Categorias de despesa |
| `dre_data` | jsonb | Dados da DRE |
| `report_data` | jsonb | Dados do relatório |
| `notes` | text | Observações |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 10. CONCILIAÇÃO BANCÁRIA

### `bank_reconciliation_batches` — Lotes de importação de extrato
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `file_name` | text NOT NULL | |
| `batch_name` | text | Nome do lote |
| `bank_name` | text | Nome do banco |
| `account` | text | Conta |
| `period_start` | date | |
| `period_end` | date | |
| `total_entries` | integer | default 0 |
| `reconciled_count` | integer | default 0 |
| `initial_balance` | numeric | |
| `final_balance` | numeric | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `bank_reconciliation_entries` — Lançamentos do extrato
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `import_batch_id` | uuid NOT NULL | FK → bank_reconciliation_batches |
| `date` | date NOT NULL | |
| `description` | text NOT NULL | |
| `amount` | numeric NOT NULL | |
| `type` | text NOT NULL | 'credit' ou 'debit' |
| `balance` | numeric | |
| `status` | text NOT NULL | 'pending', 'matched', 'ignored' |
| `matched_entry_id` | uuid | FK para cash_flow_entries ou outro |
| `matched_entry_type` | text | |
| `bank_name` | text | |
| `account` | text | |
| `notes` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `bank_statements` — Extratos bancários brutos
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `import_id` | uuid NOT NULL | FK → bank_reconciliation_batches |
| `import_date` | timestamptz | |
| `import_name` | text NOT NULL | |
| `date` | date NOT NULL | |
| `description` | text NOT NULL | |
| `amount` | numeric NOT NULL | |
| `type` | text NOT NULL | |
| `bank_ref` | text | |
| `status` | text NOT NULL | 'pending', etc |
| `matched_entry_id` | uuid | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 11. MERCADO LIVRE

### `ml_accounts` — Contas do Mercado Livre conectadas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `user_id` | uuid | FK → users |
| `store_name` | text NOT NULL | Nome da loja no ML |
| `seller_id` | bigint | ID do seller |
| `nickname` | text | |
| `access_token` | text | Token OAuth |
| `refresh_token` | text | |
| `token_expires_at` | timestamptz | |
| `status` | text | 'active' |
| `last_sync_at` | timestamptz | |
| `app_id` | text | ML App ID |
| `client_secret` | text | ML Client Secret |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `ml_items` — Anúncios/produtos do ML
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `account_id` | uuid | FK → ml_accounts |
| `item_id` | text NOT NULL | ML Item ID |
| `title` | text NOT NULL | Título do anúncio |
| `price` | numeric | Preço |
| `available_quantity` | integer | Estoque disponível |
| `sold_quantity` | integer | Total vendido |
| `status` | text | 'active', 'paused', etc |
| `sku` | text | |
| `inventory_id` | text | |
| `catalog_listing` | boolean | |
| `listing_type_id` | text | 'gold_special', etc |
| `logistic_type` | text | 'fulfillment', 'cross_docking', etc |
| `permalink` | text | Link do anúncio |
| `thumbnail` | text | URL da imagem |
| `vendas_7d` | integer | Vendas 7 dias |
| `vendas_15d` | integer | Vendas 15 dias |
| `vendas_30d` | integer | |
| `vendas_60d` | integer | |
| `vendas_90d` | integer | |
| `media_diaria` | numeric | Média diária |
| `faturamento_30d` | numeric | |
| `receita_liquida_30d` | numeric | |
| `margem_estimada` | numeric | |
| `estoque_full` | integer | Estoque Full |
| `estoque_flex` | integer | Estoque Flex |
| `estoque_dropoff` | integer | |
| `ultima_venda` | timestamptz | |
| `raw_data` | jsonb | Dados completos da API |
| `last_updated` | timestamptz | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `ml_orders` — Pedidos do ML
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `account_id` | uuid | FK → ml_accounts |
| `ml_order_id` | bigint NOT NULL | ID do pedido no ML |
| `date_created` | timestamptz | |
| `status` | text | |
| `product_title` | text | |
| `product_sku` | text | |
| `quantity` | integer | default 1 |
| `unit_price` | numeric | |
| `shipping_cost` | numeric | |
| `ml_fee` | numeric | Taxa ML |
| `net_value` | numeric | Valor líquido |
| `raw_data` | jsonb | Dados completos |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `ml_sync_logs` — Logs de sincronização ML
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `account_id` | uuid | FK → ml_accounts |
| `status` | text | 'success', 'error' |
| `message` | text | |
| `orders_synced` | integer | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `ml_alertas_promocao` — Alertas de promoção ML
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `item_id` | text NOT NULL | |
| `title` | text | |
| `campaign_name` | text | |
| `alert_type` | text NOT NULL | |
| `resolved` | boolean | default false |
| `resolved_at` | timestamptz | |
| `account_id` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 12. E-COMMERCE / ESTOQUE

### `ecom_stores` — Lojas de e-commerce
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `stock_type` | text NOT NULL | 'individual' |
| `active` | boolean NOT NULL | default true |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `ecom_products` — Produtos do e-commerce
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `title` | text NOT NULL | |
| `category` | text | |
| `active` | boolean NOT NULL | default true |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `ecom_sales` — Vendas do e-commerce
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `store_id` | uuid NOT NULL | |
| `sku` | text NOT NULL | |
| `title` | text NOT NULL | |
| `units_sold` | integer NOT NULL | default 1 |
| `created_at` | timestamptz | |

### `ecom_inventory` — Estoque do e-commerce
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `store_id` | uuid NOT NULL | |
| `sku` | text NOT NULL | |
| `initial_stock` | integer NOT NULL | default 0 |
| `entries` | integer NOT NULL | default 0 |
| `manual_adjustment` | integer NOT NULL | default 0 |
| `updated_at` | timestamptz | |

### `ecom_inventory_movements` — Movimentações de estoque
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `store_id` | uuid NOT NULL | |
| `type` | text NOT NULL | 'in', 'out', 'adjustment' |
| `quantity` | integer NOT NULL | |
| `date` | date NOT NULL | |
| `reference` | text | |
| `created_at` | timestamptz | |

### `ecom_conversion` — Taxas de conversão
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `date` | date NOT NULL | |
| `store_id` | uuid NOT NULL | |
| `sku` | text NOT NULL | |
| `visits` | integer NOT NULL | default 0 |
| `conversion_pct` | numeric NOT NULL | default 0 |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `ecom_purchase_config` — Config de compras automáticas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `store_id` | uuid NOT NULL | |
| `min_stock` | integer NOT NULL | Estoque mínimo |
| `reorder_qty` | integer NOT NULL | Qtd de reposição |
| `supplier` | text | |
| `notes` | text | |
| `active` | boolean NOT NULL | default true |
| `is_full` | boolean NOT NULL | default false |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

## 13. VIABILIDADE DE PRODUTOS

### `viabilidade_produtos` — Análise de viabilidade
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `nome` | text NOT NULL | Nome do produto |
| `link_anuncio` | text | Link do anúncio concorrente |
| `nicho` | text | Nicho |
| `categoria` | text | Categoria |
| `tipo_anuncio` | text | 'comum', 'premium' |
| `data_criacao` | date | |
| `imagem_url` | text | |
| `vendas_7d` | integer | |
| `vendas_15d` | integer | |
| `vendas_30d` | integer | |
| `preco_venda` | numeric | Preço de venda planejado |
| `tarifa_frete` | numeric | |
| `taxa_venda_pct` | numeric | Taxa de venda % |
| `imposto_pct` | numeric | Imposto % |
| `preco_medio_concorrentes` | numeric | |
| `fornecedor_id` | uuid | FK → fornecedores_cmv |
| `custo_produto` | numeric | |
| `status_analise` | text | 'sem_analise', 'analisado', etc |
| `classificacao` | text | 'testar', 'comprar', 'descartar' |
| `score` | integer | 0-100 |
| `observacoes` | text | |
| `valor_medio_7d` | numeric | |
| `valor_medio_15d` | numeric | |
| `valor_medio_30d` | numeric | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

---

## 14. PRECIFICAÇÃO

### `pricing_history` — Histórico de simulações de preço
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | text PK | |
| `product_name` | text NOT NULL | |
| `saved_at` | timestamptz NOT NULL | |
| `cost` | numeric NOT NULL | Custo do produto |
| `desired_margin` | numeric NOT NULL | Margem desejada % |
| `ml_inputs` | jsonb | Inputs do Mercado Livre |
| `shopee_inputs` | jsonb | Inputs da Shopee |
| `ml_result` | jsonb | Resultado calculado ML |
| `shopee_result` | jsonb | Resultado calculado Shopee |
| `winner` | text NOT NULL | 'ml', 'shopee', 'empate' |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 15. SKU ANALYSIS

### `sku_analyses` — Análises de SKU importadas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `month_year` | text NOT NULL | Formato 'YYYY-MM' |
| `filename` | text | Nome do arquivo importado |
| `products` | jsonb NOT NULL | Array de produtos analisados |
| `summary` | jsonb NOT NULL | Resumo da análise |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

### `sku_margin_goals` — Metas de margem por SKU
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `target_margin_pct` | numeric NOT NULL | Margem alvo % |
| `notes` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `sku_product_actions` — Ações planejadas por SKU
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `title` | text | |
| `action` | text NOT NULL | 'manter', 'reprecificar', 'descontinuar', etc |
| `month_year` | text NOT NULL | |
| `notes` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `sku_profit_analyses` — Análises de lucratividade por SKU
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `sku` | text NOT NULL | |
| `period_label` | text NOT NULL | '30 dias', etc |
| `analysis_date` | date NOT NULL | |
| `quantity` | integer NOT NULL | |
| `sale_price` | numeric NOT NULL | |
| `cost_product` | numeric NOT NULL | |
| `cost_packaging` | numeric NOT NULL | |
| `cost_shipping` | numeric NOT NULL | |
| `cost_storage` | numeric NOT NULL | |
| `ads_total` | numeric NOT NULL | |
| `ads_mode` | text NOT NULL | 'total' ou 'per_unit' |
| `marketplace_fee_pct` | numeric NOT NULL | |
| `marketplace_fee_fixed` | numeric NOT NULL | |
| `marketplace_fee_mode` | text NOT NULL | 'pct' ou 'fixed' |
| `tax_pct` | numeric NOT NULL | |
| `tax_fixed` | numeric NOT NULL | |
| `tax_mode` | text NOT NULL | 'pct' ou 'fixed' |
| `fixed_cost_rateado` | numeric NOT NULL | |
| `notes` | text | |
| `revenue_total` | numeric | |
| `ml_repasse` | numeric | |
| `ml_fees_total` | numeric | |
| `cost_extra_shipping` | numeric | |
| `seller_fee` | numeric | |
| `seller_shipping` | numeric | |
| `cost_storage_full` | numeric | |
| `cost_ads` | numeric | |
| `cost_freight_full` | numeric | |
| `ad_name` | text | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 16. TAREFAS & AGENDA

### `tasks` — Tarefas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `title` | text NOT NULL | |
| `description` | text | |
| `category` | text NOT NULL | default 'Geral' |
| `responsible` | text | |
| `priority` | text NOT NULL | 'baixa', 'media', 'alta' |
| `status` | text NOT NULL | 'pendente', 'em_andamento', 'concluida' |
| `due_date` | date | |
| `started_at` | timestamptz | |
| `completed_at` | timestamptz | |
| `time_invested_minutes` | integer | default 0 |
| `generates_result` | boolean | Se gera resultado mensurável |
| `result_registered` | boolean | default false |
| `tags` | text[] | Array de tags |
| `notes` | text | |
| `assigned_to` | uuid | FK → users |
| `created_by` | uuid | FK → users |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `task_results` — Resultados de tarefas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `task_id` | uuid NOT NULL | FK → tasks |
| `description` | text NOT NULL | |
| `financial_impact` | numeric | Impacto financeiro R$ |
| `percentage_impact` | numeric | Impacto % |
| `impact_type` | text | 'revenue', 'cost', 'saving' |
| `period` | text | Período do impacto |
| `observations` | text | |
| `registered_at` | timestamptz NOT NULL | |
| `updated_at` | timestamptz NOT NULL | |
| `store_id` | uuid | |

### `task_result_history` — Histórico de alterações de resultados
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `task_result_id` | uuid NOT NULL | FK → task_results |
| `changed_at` | timestamptz NOT NULL | |
| `changed_field` | text | |
| `old_value` | text | |
| `new_value` | text | |
| `store_id` | uuid | |

### `appointments` — Compromissos da agenda
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `title` | text NOT NULL | |
| `description` | text | |
| `category` | text NOT NULL | 'operacional', 'estrategico', etc |
| `priority` | text NOT NULL | 'baixa', 'media', 'alta' |
| `responsible` | text | |
| `start_at` | timestamptz NOT NULL | |
| `end_at` | timestamptz NOT NULL | |
| `financial_impact_type` | text | 'none', 'return', 'cost' |
| `financial_return` | numeric | |
| `financial_cost` | numeric | |
| `financial_probability` | integer | 0-100 |
| `mental_effort` | integer | 1-5 |
| `leverage` | integer | 1-5 |
| `urgency` | integer | 1-5 |
| `score` | numeric | Score calculado |
| `score_classification` | text | 'baixa', 'media', 'alta' |
| `related_task_id` | uuid | FK → tasks |
| `notify_minutes_before` | integer | default 60 |
| `color` | text | Cor hex |
| `status` | text | 'agendado', 'concluido', 'cancelado' |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `daily_alerts` — Alertas diários recorrentes
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `description` | text | |
| `alert_time` | time NOT NULL | Horário do alerta (default '08:00') |
| `category` | text NOT NULL | default 'Rotina' |
| `priority` | text NOT NULL | 'baixa', 'media', 'alta' |
| `active` | boolean NOT NULL | default true |
| `store_id` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `daily_alert_logs` — Logs de execução dos alertas
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `alert_id` | uuid NOT NULL | FK → daily_alerts |
| `log_date` | date NOT NULL | |
| `status` | text NOT NULL | 'pendente', 'concluido' |
| `action_at` | timestamptz | |
| `store_id` | uuid | |
| `created_at` | timestamptz | |

---

## 17. BACKUP & SISTEMA

### `backups` — Backups do sistema
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `label` | text NOT NULL | |
| `data` | jsonb NOT NULL | Dados completos do backup |
| `is_auto` | boolean NOT NULL | Se foi backup automático |
| `created_at` | timestamptz | |

### `admin_notices` — Avisos administrativos
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `title` | text NOT NULL | |
| `message` | text NOT NULL | |
| `type` | text NOT NULL | 'info', 'warning', 'error' |
| `is_active` | boolean NOT NULL | default true |
| `pinned` | boolean NOT NULL | Fixado no topo? |
| `created_by` | text NOT NULL | default 'Admin' |
| `expires_at` | timestamptz | |
| `target_users` | uuid[] | Array de user IDs alvo |
| `created_at` | timestamptz | |

### `release_notes` — Notas de versão
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid PK | |
| `version` | text NOT NULL | |
| `date` | text NOT NULL | |
| `title` | text NOT NULL | |
| `highlight` | text | Destaque |
| `changes` | jsonb NOT NULL | Array de mudanças |
| `created_at` | timestamptz | |

---

## 🔑 PADRÕES IMPORTANTES

### Convenções de nomenclatura
- **Datas**: `date` (SQL date) ou `created_at` (timestamptz)
- **Mês/ano**: Formato string `'YYYY-MM'` na coluna `mes_referencia`, `fatura_mes`, `month_year`, `mes_ano`
- **Valores monetários**: `numeric` (NUNCA `float` ou `double precision`)
- **IDs**: `uuid` com `gen_random_uuid()` como default
- **Status**: Sempre `text` com valores pré-definidos (pendente/pago/atrasado, etc)
- **Booleans**: `boolean` com snake_case (is_active, is_origem, etc)
- **Multi-tenancy**: `store_id` (uuid, nullable) presente em quase toda tabela

### Empresas (campo `empresa`)
- Não é FK, é um campo `text` que armazena a key: `'UNIFULL'`, `'TOP MIX'`, `'R SOUZA'`
- Pode ser `null` (sem empresa definida)
- Constante `EMPRESAS` em `src/pages/compras-cmv/constants.ts`
- Presente nas tabelas: `boletos_mensais`, `boletos_recorrentes`, `receivables`, `compras_cmv`
- **Sempre usar `.trim()` ao comparar**

### Relacionamentos Chave
- `boletos_mensais.id_recorrente` → `boletos_recorrentes.id`
- `boletos_mensais.cartao_id` → `cartoes.id`
- `boletos_mensais.divida_id` → `boletos_mensais.id` (auto-referência: dívida origem)
- `parcelas_cartao.divida_id` → `boletos_mensais.id`
- `parcelas_cartao.cartao_id` → `cartoes.id`
- `cash_flow_entries.boleto_id` → `boletos_mensais.id`
- `fatura_pagamentos.cartao_id` → `cartoes.id`

### Funções Edge (Supabase)
| Slug | Descrição |
|------|-----------|
| `send-boletos-reminder` | Envia e-mail com boletos que vencem hoje/amanhã |
| `send-cash-flow-forecast-email` | Envia projeção de caixa por e-mail |
| `forecast-scheduler` | Scheduler diário 8h (Brasília) |
| `send-daily-alerts-summary` | Resumo de alertas diários (21h) |
| `manage-alert-email-schedule` | Gerencia schedule de e-mails de alerta |
| `send-appointment-email` | Notificação de compromissos |
| `setup-admin` | Configura admin inicial |
| `update-admin-password` | Atualiza senha do admin |
| `send-login-alert` | Alerta de falha de login |
| `ai-assistant-chat` | Chat do assistente IA |
| `send-monthly-closing-email` | E-mail de fechamento mensal |
| `send-password-reset-email` | E-mail de reset de senha |
| `reset-password` | Reset de senha |
| `ml-oauth` | OAuth Mercado Livre |
| `erp-api-proxy` | Proxy da API do ERP |
| `send-ml-promo-alerts` | Alertas de promoção ML (Telegram) |