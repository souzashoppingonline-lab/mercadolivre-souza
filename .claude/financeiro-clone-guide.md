# FinanceEcom — Documentação Completa para Clone do Sistema

> **Objetivo deste documento:** Fornecer TODAS as informações necessárias para que outro desenvolvedor/IA (ex: Claude Code) possa recriar este sistema ERP do zero, incluindo estrutura de banco de dados, frontend, regras de negócio, autenticação e arquitetura.

---

## 1. VISÃO GERAL DO PRODUTO

**Nome:** FinanceEcom — Gestão Financeira para E-commerce  
**Propósito:** ERP completo para vendedores de marketplace (Mercado Livre, Shopee, etc.) gerenciarem:
- Lançamento diário de vendas com cálculo de margem de contribuição real
- Controle de despesas fixas e operacionais com DRE automático
- Fluxo de caixa, boletos, cartões de crédito, parcelamentos
- Projeção financeira, ponto de equilíbrio (break-even)
- Controle de compras com importação de XML fiscal (NF-e)
- Gestão de estoque, tarefas/kanban, conciliação bancária
- Integração com Mercado Livre (OAuth)

**Público-alvo:** Empreendedores e gestores de e-commerce que vendem em marketplaces.

---

## 2. TECH STACK

### Frontend
| Tecnologia | Versão | Uso |
|---|---|---|
| React | ^19.1.0 | Framework UI |
| TypeScript | ~5.8.3 | Tipagem estática |
| TailwindCSS | ^3.4.17 | Estilização utilitária |
| React Router DOM | ^7.6.3 | Roteamento SPA |
| Vite | ^8.0.1 | Build tool |
| Recharts | 3.2.0 | Gráficos |
| AG Grid | ^33.1.0 / 34.1.2 | Tabelas avançadas |
| jsPDF + autotable | 2.5.2 + 3.8.4 | Exportação PDF |
| xlsx | 0.18.5 | Exportação Excel |
| Chart.js | 4.4.0 | Gráficos canvas |
| html2canvas | 1.4.1 | Captura de screenshots |
| i18next | 25.4.1 | Internacionalização |
| Lucide React | 0.539.0 | Ícones SVG |
| JSZip | 3.10.1 | Compactação |

### Backend (Supabase)
| Componente | Uso |
|---|---|
| PostgreSQL (Supabase) | Banco de dados principal (~60 tabelas) |
| Supabase Auth | Autenticação (substituído por auth customizada via tabela `users`) |
| Supabase Storage | Armazenamento de XMLs fiscais (`xml-notas`, `produtos-cmv`) |
| Supabase Edge Functions | 18 funções serverless (emails, OAuth, AI, alertas) |
| Supabase RLS | Row Level Security em todas as tabelas |

**IMPORTANTE:** A autenticação NÃO usa Supabase Auth nativo. O sistema tem sua própria tabela `users` com hash de senha customizado (salt fixo + algoritmo próprio). O `supabase-js` é usado apenas como cliente de banco de dados (`.from().select/insert/update/delete`), storage (`.storage.from()`) e edge functions (`.functions.invoke()`).

### Dependências NPM (package.json)
```json
{
  "dependencies": {
    "@stripe/react-stripe-js": "4.0.2",
    "@supabase/supabase-js": "2.57.4",
    "@tanstack/react-table": "8.21.3",
    "ag-grid-community": "^33.1.0",
    "ag-grid-react": "34.1.2",
    "chart.js": "4.4.0",
    "firebase": "12.0.0",
    "html2canvas": "1.4.1",
    "i18next": "25.4.1",
    "i18next-browser-languagedetector": "^8.2.0",
    "jspdf": "2.5.2",
    "jspdf-autotable": "3.8.4",
    "jszip": "3.10.1",
    "lucide-react": "0.539.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-i18next": "^15.6.0",
    "react-router-dom": "^7.6.3",
    "recharts": "3.2.0",
    "xlsx": "0.18.5"
  }
}
```

---

## 3. ESTRUTURA DE ARQUIVOS DO PROJETO

```
/
├── index.html                          # HTML principal (CDN icons, CSP, loading fallback)
├── package.json                        # Dependências
├── vite.config.ts                      # Config Vite (aliases, auto-import, define globals)
├── tailwind.config.ts                  # Config Tailwind (vazio, sem theme.extend customizado)
├── tsconfig.json / tsconfig.app.json   # Config TypeScript
├── postcss.config.ts                   # PostCSS + Tailwind + Autoprefixer
├── .env                                # VITE_PUBLIC_SUPABASE_URL, VITE_PUBLIC_SUPABASE_ANON_KEY
├── project_plan.md                     # Planejamento do projeto
├── supabase/
│   └── functions/                      # 18 Edge Functions
│       ├── ai-assistant-chat/
│       ├── erp-api-proxy/
│       ├── forecast-scheduler/
│       ├── manage-alert-email-schedule/
│       ├── ml-oauth/
│       ├── reset-admin-password-temp/
│       ├── reset-password/
│       ├── reset-suelen-password/
│       ├── send-appointment-email/
│       ├── send-boletos-reminder/
│       ├── send-daily-alerts-summary/
│       ├── send-forecast-email/
│       ├── send-login-alert/
│       ├── send-ml-promo-alerts/
│       ├── send-monthly-closing-email/
│       ├── send-password-reset-email/
│       ├── setup-admin/
│       └── update-admin-password/
└── src/
    ├── main.tsx                         # Entry point: renderiza <App />
    ├── App.tsx                          # BrowserRouter + AuthProvider + AppRoutes
    ├── index.css                        # Tailwind directives + fontes + animações CSS
    ├── router/
    │   ├── index.ts                     # AppRoutes (useRoutes) + navigatePromise
    │   └── config.tsx                   # 28 RouteObject[] com lazy loading + ProtectedRoute
    ├── lib/
    │   ├── supabase.ts                  # Singleton Supabase client com lazy init
    │   ├── cartaoUtils.ts               # Utilitários para cartões
    │   ├── dateUtils.ts                 # Utilitários de data
    │   └── nfUtils.ts                   # Utilitários de NF-e
    ├── hooks/
    │   ├── useAuth.ts                   # Contexto de autenticação + AuthProvider
    │   ├── useAlertBell.ts              # Hook do sino de alertas
    │   ├── useSidebarCollapse.ts        # Hook de colapso da sidebar
    │   ├── useToastSound.ts             # Hook do som do toast
    │   └── useUrgentNotices.ts          # Hook de avisos urgentes
    ├── components/
    │   ├── base/
    │   │   ├── TiltCard.tsx             # Card com efeito tilt 3D
    │   │   └── Toast.tsx                # Componente de toast/notificação
    │   └── feature/
    │       ├── AlertBell.tsx            # Sino de notificações
    │       ├── AlterarSenhaModal.tsx    # Modal de alteração de senha
    │       ├── ComingSoonPage.tsx       # Placeholder "Em breve"
    │       ├── MainLayout.tsx           # Layout principal (sidebar + conteúdo)
    │       ├── MonthlyReviewWizard.tsx  # Wizard de revisão mensal
    │       └── Sidebar.tsx              # Barra lateral com navegação
    ├── types/
    │   └── index.ts                     # TODOS os tipos TypeScript do sistema
    ├── i18n/
    │   ├── index.ts                     # Config i18next
    │   └── local/
    │       └── index.ts                 # Arquivos de tradução
    ├── mocks/                           # Dados mock para páginas sem backend
    │   ├── capitalGiro.ts
    │   └── releaseNotes.ts
    └── pages/
        ├── NotFound.tsx
        ├── home/                        # Home — Painel de Controle
        ├── vendas/                      # Vendas & Custos
        ├── relatorios/                  # Relatórios
        ├── despesas/                    # Despesas & DRE Integrado
        ├── dre/                         # DRE Mensal
        ├── fluxo-caixa/                 # Fluxo de Caixa
        ├── boletos/                     # Boletos & Dívidas
        ├── projecao-caixa/              # Projeção de Caixa
        ├── tarefas/                     # Tarefas (Kanban)
        │   ├── agenda/                  # Agenda
        │   ├── resultados-pendentes/    # Resultados Pendentes
        │   ├── banco-resultados/        # Banco de Resultados
        │   └── alertas-diarios/         # Alertas Diários
        ├── conciliacao-bancaria/        # Conciliação Bancária
        ├── compras-cmv/                 # Compras
        ├── backup/                      # Backup
        ├── fechamento-mensal/           # Fechamento Mensal
        ├── capital-giro/                # Capital de Giro
        ├── ecom-estoque/                # Vendas & Estoque
        ├── erp-ml/                      # ERP Mercado Livre
        ├── usuarios/                    # Gestão de Usuários
        ├── dashboard/                   # Painel Admin
        ├── notas-atualizacao/           # Notas de Atualização
        └── login/                       # Login, Esqueci Senha, Reset Senha
```

### Convenções de código:
- **Imports cross-directory:** sempre usar `@/` (ex: `import X from '@/components/feature/Sidebar'`), NUNCA `../`
- **Imports same-directory:** usar `./`
- **Export default:** todo `page.tsx` e componente deve ter `export default`
- **Mock files:** usar `export const`, nunca `export default`, extensão `.ts`
- **Componentes React:** importar APIs nomeadas de 'react' (`useState`, `useEffect`, etc.), NUNCA `React.xxx`
- **Ícones:** Remix Icon (`ri-*`) e Font Awesome (`fa-*`) via CDN no index.html, sem npm imports

---

## 4. ARQUITETURA DE ROTEAMENTO

### Mecanismo:
- `src/router/index.ts` exporta `AppRoutes` que usa `useRoutes(routes)` do React Router
- `src/router/config.tsx` define `RouteObject[]` com lazy loading em TODAS as páginas
- `ProtectedRoute` wrapper verifica `useAuth().isAuthenticated` e `useAuth().hasAccess(pagePath)`
- `__BASE_PATH__` é injetado via Vite `define` (vem de `process.env.BASE_PATH`)
- `window.REACT_APP_NAVIGATE` e `navigatePromise` são expostos globalmente

### Estrutura do BrowserRouter em App.tsx:
```tsx
<I18nextProvider i18n={i18n}>
  <BrowserRouter basename={__BASE_PATH__}>
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  </BrowserRouter>
</I18nextProvider>
```

### Vite Auto-Import:
React hooks e react-router-dom hooks são auto-importados globalmente (não precisa de `import` no topo dos arquivos). Configurado via `unplugin-auto-import` no `vite.config.ts`.

---

## 5. AUTENTICAÇÃO & AUTORIZAÇÃO

### Fluxo de Login:
1. Usuário submete email + senha no form `/login`
2. Senha é hasheada com algoritmo customizado: `hashPassword(password, salt)` — combina password + salt fixo (`fin_ecom_2024_salt_v1`), faz 1000 rounds de mixing, retorna hash hexadecimal 64 chars
3. Query na tabela `users` por `email` + `password_hash` + `is_active = true`
4. Se sucesso: salva `{ userId, email }` no localStorage (`financeecom_auth`), carrega permissões da tabela `user_permissions`
5. Se falha: registra em `access_logs` com action `login_failed`, dispara edge function `send-login-alert` se >=5 falhas em 15min, bloqueia por 15min

### Verificação de Sessão:
- Ao carregar, `AuthProvider.loadSession()` lê localStorage, valida contra `users` no Supabase
- Carrega permissões via `user_permissions.where('user_id', ...)`

### Permissões:
- `users.role`: `'admin'` ou `'user'`
- Admin tem acesso TOTAL a tudo
- User comum: permissões granulares via `user_permissions` (can_access, can_edit, can_delete por page_path)
- `ProtectedRoute` verifica `hasAccess(pagePath)` antes de renderizar

### Tabelas de Auth:
- `users`: id, email, name, password_hash, role, is_active, created_at
- `user_permissions`: id, user_id, page_path, can_access, can_edit, can_delete
- `access_logs`: id, user_id, user_email, user_name, action, user_agent, created_at

---

## 6. BANCO DE DADOS — SCHEMA COMPLETO

### ⚠️ INSTRUÇÃO IMPORTANTE:
Todas as tabelas devem ser criadas no Supabase PostgreSQL. **NÃO usar Supabase Auth nativo** — a autenticação é 100% customizada via tabela `users`.

### 6.1 Tabelas Core

#### `stores` — Lojas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome da loja |
| cnpj | text | CNPJ (nullable) |
| nome_fantasia | text | Nome fantasia (nullable) |
| razao_social | text | Razão social (nullable) |
| banco_nome | text | Banco (nullable) |
| banco_agencia | text | Agência (nullable) |
| banco_conta | text | Conta (nullable) |
| banco_tipo | text | Tipo conta (nullable) |
| ativa | boolean | Loja ativa |
| goal_card_color | text | Cor do card de meta (nullable) |
| created_at | timestamptz | |

#### `contas_bancarias` — Contas Bancárias
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| nome | text | Nome da conta |
| banco_nome | text | Nome do banco (nullable) |
| banco_agencia | text | Agência (nullable) |
| banco_conta | text | Conta (nullable) |
| banco_cnpj | text | CNPJ (nullable) |
| banco_tipo | text | Tipo (nullable) |
| ativa | boolean | |
| created_at | timestamptz | |

#### `conta_empresas` — Vínculo Conta ↔ Empresa
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| conta_bancaria_id | uuid FK → contas_bancarias | |
| empresa | text | Nome da empresa |
| created_at | timestamptz | |

### 6.2 Vendas

#### `sales_entries` — Lançamentos de Vendas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| date | date | Data do lançamento |
| quantity_sales | integer | Quantidade de vendas |
| gross_revenue | numeric | Receita bruta |
| marketplace_fees | numeric | Taxas marketplace |
| subsidized_shipping | numeric | Frete subsidiado |
| cogs | numeric | Custo da mercadoria vendida (CMV) |
| ads_ml | numeric | Anúncios Mercado Livre |
| ads_external | numeric | Anúncios externos (Meta/Google) |
| tax | numeric | Impostos |
| store_id | uuid FK → stores | Loja (nullable) |
| created_at | timestamptz | |

#### `monthly_goals` — Metas Mensais
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| month | integer | Mês (1-12) |
| year | integer | Ano |
| goal_value | numeric | Valor da meta |
| store_id | uuid FK → stores | Loja (nullable, null = geral) |
| created_at | timestamptz | |

### 6.3 Despesas

#### `expense_categories` — Categorias de Despesa
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome da categoria |
| store_id | uuid FK → stores | (nullable) |
| created_at | timestamptz | |

#### `expenses` — Despesas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| type | text | 'fixed' ou 'operational' |
| description | text | Descrição |
| category_id | uuid FK → expense_categories | (nullable) |
| value | numeric | Valor |
| date | date | Data |
| is_recurring | boolean | É recorrente |
| month | integer | Mês referência |
| year | integer | Ano referência |
| store_id | uuid FK → stores | (nullable) |
| created_at | timestamptz | |

### 6.4 Fluxo de Caixa

#### `cash_flow_entries` — Movimentações
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| date | date | Data |
| type | text | 'income' ou 'expense' |
| value | numeric | Valor |
| store_id | uuid FK → stores | (nullable) |
| category | text | Categoria (nullable) |
| reason | text | Motivo (nullable) |
| boleto_id | uuid | Vínculo com boleto (nullable) |
| empresa | text | Empresa (nullable) |
| nota_fiscal | text | NF (nullable) |
| conta_bancaria_id | uuid FK → contas_bancarias | (nullable) |
| created_at | timestamptz | |

#### `cash_flow_categories` — Categorias
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| type | text | 'income' ou 'expense' |
| created_at | timestamptz | |

#### `cash_flow_recurring` — Entradas Recorrentes
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| type | text | 'income' ou 'expense' |
| value | numeric | Valor |
| category | text | (nullable) |
| reason | text | (nullable) |
| store_id | uuid | (nullable) |
| day_of_month | integer | Dia do mês |
| active | boolean | Ativo |
| created_at | timestamptz | |

#### `forecast_starting_balance` — Saldo Inicial Projeção
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| month | integer | Mês |
| year | integer | Ano |
| balance | numeric | Saldo inicial |
| created_at | timestamptz | |

#### `forecast_inflow_overrides` — Overrides de Projeção
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| date | date | Data |
| type | text | 'income' ou 'expense' |
| value | numeric | Valor |
| description | text | |
| created_at | timestamptz | |

#### `manual_cash_flow_values` — Ajustes Manuais
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| date | date | Data |
| type | text | 'income' ou 'expense' |
| value | numeric | Valor |
| description | text | |
| created_at | timestamptz | |

### 6.5 Boletos & Dívidas

#### `boleto_categories` — Categorias de Boleto
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| created_at | timestamptz | |

#### `boletos_mensais` — Boletos
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| id_recorrente | uuid FK → boletos_recorrentes | (nullable) |
| name | text | Nome |
| category | text | Categoria |
| supplier | text | Fornecedor (nullable) |
| date | date | Vencimento |
| value | numeric | Valor |
| status | text | 'pendente', 'pago', 'atrasado' |
| mes_referencia | text | Mês referência |
| numero_parcela | integer | Nº parcela (nullable) |
| cartao_credito | text | Cartão (nullable) |
| banco | text | Banco (nullable) |
| empresa | text | Empresa (nullable) |
| numero_nf | text | NF (nullable) |
| tipo | text | 'boleto','manual','cartao','pessoal','fatura_ml','flex','custo_fixo','custo_variavel' |
| cartao_id | uuid FK → cartoes | (nullable) |
| divida_id | uuid | Vínculo dívida (nullable) |
| is_origem | boolean | É o boleto origem |
| valor_total | numeric | Valor total |
| numero_parcelas | integer | Total parcelas (nullable) |
| data_compra | date | Data compra (nullable) |
| created_at | timestamptz | |

#### `boletos_recorrentes` — Templates Recorrentes
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| nome | text | Nome |
| categoria | text | Categoria |
| fornecedor | text | (nullable) |
| empresa | text | (nullable) |
| dia_vencimento | integer | Dia do mês |
| ativo | boolean | |
| total_parcelas | integer | (nullable) |
| parcela_atual | integer | |
| valor_total | numeric | |
| cartao_credito | text | (nullable) |
| banco | text | (nullable) |
| tipo | text | (nullable) |
| created_at | timestamptz | |

#### `cartoes` — Cartões de Crédito
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| nome | text | Nome |
| bandeira | text | Bandeira (nullable) |
| dia_fechamento | integer | Dia fechamento |
| dia_vencimento | integer | Dia vencimento |
| cor | text | Cor (hex) |
| ativo | boolean | |
| limite | numeric | Limite |
| created_at | timestamptz | |

#### `parcelas_cartao` — Parcelas de Cartão
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| divida_id | uuid | ID da dívida |
| numero_parcela | integer | Nº |
| data_vencimento | date | Vencimento |
| valor | numeric | Valor |
| status | text | 'pendente' ou 'pago' |
| fatura_mes | text | Mês fatura |
| cartao_id | uuid FK → cartoes | (nullable) |
| boleto_mensal_id | uuid FK → boletos_mensais | (nullable) |
| tag_id | uuid FK → parcela_tags | (nullable) |
| empresa | text | (nullable) |
| created_at | timestamptz | |

#### `fatura_pagamentos` — Pagamentos de Fatura
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| cartao_id | uuid FK → cartoes | |
| fatura_mes | text | Mês |
| data_pagamento | date | |
| valor_pago | numeric | |
| parcelas_count | integer | |
| created_at | timestamptz | |

#### `parcela_tags` — Tags de Parcela
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| nome | text | |
| cor | text | |
| created_at | timestamptz | |

#### `receivables` — Recebíveis
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| date | date | Data |
| description | text | (nullable) |
| value | numeric | Valor |
| recebido | boolean | |
| data_recebimento | date | (nullable) |
| empresa | text | (nullable) |
| created_at | timestamptz | |

### 6.6 Compras & NF-e

#### `compras_cmv` — Compras
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| fornecedor_nome | text | Fornecedor |
| data_compra | date | Data compra |
| data_entrada | date | Data entrada (nullable) |
| valor_total | numeric | Valor total |
| status_entrega | text | 'pendente' ou 'entregue' |
| empresa | text | Empresa |
| xml_url | text | URL do XML (nullable) |
| origem | text | 'MANUAL' ou 'XML' |
| chave_nfe | text | Chave NF-e 44 dígitos (nullable) |
| numero_nf | text | Número NF (nullable) |
| serie_nf | text | Série NF (nullable) |
| valor_nfe | numeric | Valor NF-e (nullable) |
| valor_pago | numeric | Valor pago (nullable) |
| diferenca_nfe | numeric | Diferença (nullable) |
| valor_alterado | boolean | (nullable) |
| motivo_alteracao | text | (nullable) |
| v_icms | numeric | (nullable) |
| v_ipi | numeric | (nullable) |
| v_pis | numeric | (nullable) |
| v_cofins | numeric | (nullable) |
| v_frete | numeric | (nullable) |
| v_st | numeric | (nullable) |
| v_desconto | numeric | (nullable) |
| observacao | text | (nullable) |
| created_at | timestamptz | |

#### `compras_xml` — XMLs Importados
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| chave_nfe | text | Chave NF-e |
| numero_nf | text | Número NF |
| serie_nf | text | Série |
| fornecedor_nome | text | Fornecedor |
| data_emissao | date | Emissão |
| valor_total | numeric | Valor |
| empresa | text | Empresa |
| xml_url | text | URL Storage |
| dados_completos | jsonb | Dados parseados |
| created_at | timestamptz | |

#### `auditoria_xml_importacao` — Auditoria
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| chave_nfe | text | Chave NF-e |
| usuario | text | Usuário |
| empresa | text | Empresa |
| valores_originais | jsonb | |
| valores_finais | jsonb | |
| created_at | timestamptz | |

#### `fornecedores_cmv` — Fornecedores
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| nome | text | Nome |
| cnpj_cpf | text | Documento (nullable) |
| contato | text | (nullable) |
| prazo_pagamento | integer | Dias (nullable) |
| lead_time_dias | integer | Dias (nullable) |
| status | text | 'ativo' ou 'inativo' |
| created_at | timestamptz | |

#### `produtos_cmv` — Produtos
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| sku | text | SKU |
| nome | text | Nome |
| categoria | text | Categoria (nullable) |
| custo_medio_atual | numeric | Custo médio |
| estoque_atual | numeric | Estoque |
| data_ultima_compra | date | (nullable) |
| status | text | 'ativo' ou 'inativo' |
| created_at | timestamptz | |

#### `itens_compra_cmv` — Itens da Compra
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| compra_id | uuid FK → compras_cmv | |
| produto_id | uuid FK → produtos_cmv | (nullable) |
| sku | text | SKU |
| nome | text | Nome |
| quantidade | numeric | Qtd |
| custo_unitario | numeric | Custo unit. |
| created_at | timestamptz | |

#### `historico_custo_cmv` — Histórico de Custo
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| produto_id | uuid FK → produtos_cmv | |
| custo_anterior | numeric | |
| custo_novo | numeric | |
| data_alteracao | timestamptz | |
| motivo | text | (nullable) |

### 6.7 Tarefas & Alertas

#### `tasks` — Tarefas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| title | text | Título |
| description | text | (nullable) |
| status | text | 'backlog','in_progress','done' |
| priority | text | 'low','medium','high','urgent' |
| assigned_to | uuid FK → users | (nullable) |
| is_recurring | boolean | |
| recurrence_rule | text | (nullable) |
| deadline | timestamptz | (nullable) |
| checklist | jsonb | (nullable) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### `task_results` — Resultados
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| task_id | uuid FK → tasks | |
| value | numeric | Valor |
| notes | text | (nullable) |
| status | text | 'pending_review','approved','rejected' |
| created_by | uuid FK → users | |
| created_at | timestamptz | |

#### `task_result_history` — Histórico de Resultados
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| task_result_id | uuid FK → task_results | |
| action | text | |
| previous_value | numeric | (nullable) |
| new_value | numeric | (nullable) |
| performed_by | uuid FK → users | |
| created_at | timestamptz | |

#### `daily_alerts` — Alertas Diários
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| time | time | Horário |
| category | text | Categoria |
| days_of_week | integer[] | Dias da semana |
| active | boolean | |
| created_at | timestamptz | |

#### `daily_alert_logs` — Log de Alertas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| alert_id | uuid FK → daily_alerts | |
| date | date | Data |
| status | text | 'done','skipped','missed' |
| completed_at | timestamptz | (nullable) |
| created_at | timestamptz | |

#### `appointments` — Compromissos (Agenda)
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| title | text | Título |
| description | text | (nullable) |
| start_time | timestamptz | Início |
| end_time | timestamptz | Fim |
| all_day | boolean | |
| color | text | (nullable) |
| created_at | timestamptz | |

### 6.8 E-commerce & Estoque

#### `ecom_stores` — Lojas E-commerce
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| platform | text | Plataforma |
| created_at | timestamptz | |

#### `ecom_products` — Produtos
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| sku | text | SKU |
| name | text | Nome |
| cost | numeric | Custo |
| price | numeric | Preço |
| store_id | uuid FK → ecom_stores | (nullable) |
| created_at | timestamptz | |

#### `ecom_inventory` — Estoque
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK → ecom_products | |
| quantity | integer | Quantidade |
| min_stock | integer | Estoque mínimo |
| store_id | uuid FK → ecom_stores | (nullable) |
| updated_at | timestamptz | |

#### `ecom_inventory_movements` — Movimentações
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK → ecom_products | |
| quantity_change | integer | Variação |
| reason | text | Motivo |
| created_at | timestamptz | |

#### `ecom_sales` — Vendas E-commerce
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK → ecom_products | |
| quantity | integer | Qtd |
| revenue | numeric | Receita |
| date | date | Data |
| store_id | uuid FK → ecom_stores | (nullable) |
| created_at | timestamptz | |

#### `ecom_conversion` — Conversão
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK → ecom_products | |
| impressions | integer | Impressões |
| clicks | integer | Cliques |
| sales | integer | Vendas |
| date | date | Data |
| created_at | timestamptz | |

#### `ecom_purchase_config` — Config de Compra
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK → ecom_products | |
| min_order_qty | integer | Qtd mínima |
| lead_time_days | integer | Lead time |
| supplier | text | Fornecedor |
| created_at | timestamptz | |

### 6.9 Mercado Livre

#### `ml_accounts` — Contas ML
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| user_id | text | ID ML |
| nickname | text | Apelido |
| access_token | text | Token (encrypted) |
| refresh_token | text | Refresh token |
| token_expires_at | timestamptz | Expiração |
| created_at | timestamptz | |

#### `ml_orders` — Pedidos ML
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| order_id | text | ID ML |
| account_id | uuid FK → ml_accounts | |
| status | text | Status |
| total_amount | numeric | Total |
| date_created | timestamptz | |
| items | jsonb | Itens |
| created_at | timestamptz | |

#### `ml_sync_logs` — Log de Sync
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| account_id | uuid FK → ml_accounts | |
| sync_type | text | Tipo |
| status | text | 'success','error' |
| records_count | integer | |
| error_message | text | (nullable) |
| created_at | timestamptz | |

#### `ml_items` — Anúncios ML
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| item_id | text | ID ML |
| title | text | Título |
| price | numeric | Preço |
| available_quantity | integer | Estoque |
| status | text | Status |
| account_id | uuid FK → ml_accounts | |
| created_at | timestamptz | |

#### `ml_alertas_promocao` — Alertas de Promoção
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| item_id | text | ID ML |
| alert_type | text | Tipo |
| message | text | Mensagem |
| resolved | boolean | |
| created_at | timestamptz | |

### 6.10 Sistema

#### `users` — Usuários
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| email | text UNIQUE | |
| name | text | |
| password_hash | text | Hash customizado |
| role | text | 'admin' ou 'user' |
| is_active | boolean | |
| created_at | timestamptz | |

#### `user_permissions` — Permissões
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users | |
| page_path | text | Path da rota |
| can_access | boolean | |
| can_edit | boolean | |
| can_delete | boolean | |
| created_at | timestamptz | |

#### `access_logs` — Log de Acessos
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users | (nullable) |
| user_email | text | |
| user_name | text | |
| action | text | 'login','login_failed','logout' |
| user_agent | text | |
| created_at | timestamptz | |

#### `backups` — Backups
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| label | text | Rótulo |
| data | jsonb | Snapshot de dados |
| is_auto | boolean | Automático |
| created_at | timestamptz | |

#### `monthly_closing` — Fechamento Mensal
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| month | integer | Mês |
| year | integer | Ano |
| data | jsonb | Snapshot |
| created_at | timestamptz | |

#### `system_settings` — Configurações
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| key | text | Chave |
| value | text | Valor |
| created_at | timestamptz | |

#### `release_notes` — Notas de Atualização
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| version | text | Versão |
| title | text | Título |
| description | text | Descrição |
| tags | text[] | Tags |
| created_at | timestamptz | |

#### `admin_notices` — Avisos Admin
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| title | text | Título |
| message | text | Mensagem |
| severity | text | 'info','warning','danger' |
| active | boolean | |
| expires_at | timestamptz | (nullable) |
| created_at | timestamptz | |

#### `password_reset_tokens` — Tokens Reset Senha
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users | |
| token | text | Token |
| expires_at | timestamptz | |
| used | boolean | |
| created_at | timestamptz | |

### 6.11 Conciliação Bancária

#### `bank_reconciliation_batches` — Lotes
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| name | text | Nome |
| conta_bancaria_id | uuid FK → contas_bancarias | |
| import_date | timestamptz | |
| total_entries | integer | |
| matched_count | integer | |
| created_at | timestamptz | |

#### `bank_reconciliation_entries` — Entradas
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |
| batch_id | uuid FK → bank_reconciliation_batches | |
| date | date | Data |
| description | text | Descrição |
| value | numeric | Valor |
| type | text | 'credit' ou 'debit' |
| matched_entry_id | uuid FK → cash_flow_entries | (nullable) |
| status | text | 'matched','divergent','unmatched' |
| created_at | timestamptz | |

#### `bank_statements` — Extratos (tabela auxiliar)
| Coluna | Tipo | Descrição |
|---|---|---|
| id | uuid PK | |

### 6.12 SKU & Pricing

#### `sku_analyses` — Análises SKU
#### `sku_product_actions` — Ações de Produto
#### `sku_margin_goals` — Metas de Margem SKU
#### `sku_profit_analyses` — Análises de Lucro SKU
#### `pricing_history` — Histórico de Preços
#### `viabilidade_produtos` — Viabilidade de Produtos

> Essas tabelas de SKU/pricing são usadas principalmente no módulo E-commerce Estoque. O schema exato deve ser inferido dos componentes.

---

## 7. ROTAS & PÁGINAS — DESCRIÇÃO COMPLETA

### 7.1 `/login` — Login
- **Componentes:** Form de email + senha, link "Esqueci minha senha"
- **Lógica:** `useAuth().login(email, password)` → hash customizado → query `users`
- **Rate limiting:** 5 tentativas em 15min → bloqueio
- **Edge Functions:** `send-login-alert` (emails de tentativa de login)

### 7.2 `/forgot-password` — Esqueci Senha
- Form de email → chama `send-password-reset-email` edge function → gera token em `password_reset_tokens`

### 7.3 `/reset-password` — Resetar Senha
- Form com token (da URL) + nova senha → `reset-password` edge function

### 7.4 `/` — Home / Painel de Controle
- **Tabelas:** sales_entries, cash_flow_entries, boletos_mensais, expenses, receivables, monthly_goals, daily_alerts, daily_alert_logs, compras_xml, backups
- **Componentes principais:**
  - `FinancialHealth` — Score 0-100 com 5 pilares (Lucro Líquido, Caixa, Boletos, Recebíveis, Meta); anel SVG + barras de progresso
  - `HomeQuickCards` — 4 cards de indicadores: receita mês, saldo caixa, boletos pendentes, despesas
  - `HomeAlertsSummary` — Barra de progresso de alertas diários com pills de status
  - `ConciliacaoDashboard` — Donut chart NF-e (quitadas/pendentes/parciais/sem boleto/sem XML) + top fornecedores + banner divergências
  - `MonthlyReviewWizard` — Wizard de revisão mensal
  - QuickLinks — 6 atalhos

### 7.5 `/vendas` — Vendas & Custos
- **Tabelas:** stores, sales_entries, monthly_goals
- **Regra de negócio principal:** Margem de Contribuição = gross_revenue - marketplace_fees - subsidized_shipping - cogs - ads_ml - ads_external - tax
- **Semáforo de margem:** verde >25%, amarelo 15-25%, vermelho <15%, negativo = prejuízo
- **Componentes:** SalesForm (CRUD), SalesTable, MonthlyGoal (meta + run rate), StoreGoalCard (grid por loja), DailyGoalTable (dia a dia com semáforo), MonthlyTotals (cards KPI), StoreReports (ranking), MarginLineChart (evolução diária %), RevenueMarginBarChart (barras empilhadas), SalesSummaryChart (donut custos), WeekdaySalesChart (radar), SameDayComparison (mês atual vs anterior), WeekdayComparison, WeekdayDrillModal
- **Exportação:** Excel (xlsx), CSV, PDF

### 7.6 `/relatorios` — Relatórios
- **Tabelas:** stores, sales_entries, cash_flow_entries, expenses, expense_categories, boletos_mensais
- **Componentes:** GerencialDashboard (painel completo), GerencialCharts, GerencialTables, GerencialCalendar, GerencialExport, TrendCharts, CustosDespesas3Meses, ResumoMensalCategorias, BoletosReport, MonthlyExportReport, AdsCard + AdsDetailModal + AdsDiagnostic, MarginSemaphore, ComparisonCard, TacosMonthlyCard

### 7.7 `/despesas` — Despesas & DRE Integrado
- **Tabelas:** expenses, expense_categories, sales_entries
- **2 abas:** "DRE & Despesas" + "Ponto de Equilíbrio"
- **Componentes Aba 1:** ExpenseForm (CRUD: tipo fixa/operacional, descrição, categoria, valor, recorrente), ExpenseTable (agrupada), DreSummaryPanel (mini-DRE anual), DreDetailedSection (DRE completo), CategoryBreakdown (donut), BreakEvenImpactRanking, CategoryTrendChart, CategoryComparisonTable, CategoryModal, RecurringModal, ClearModal
- **Componentes Aba 2:** BreakEvenTab, BreakEvenChart (gauge velocímetro), BreakEvenSimulator (interativo), BreakEvenGoalSimulator
- **Regra Break-Even:** (custos fixos + operacionais) / (margem contribuição %) = faturamento mínimo

### 7.8 `/dre` — DRE Mensal
- **Tabelas:** sales_entries, expenses, expense_categories
- **Componentes:** DreSummaryCards, DreMonthGrid, DreFullReport, DreHistoryTable, DreAnnualProjection

### 7.9 `/fluxo-caixa` — Fluxo de Caixa
- **Tabelas:** stores, contas_bancarias, conta_empresas, cash_flow_entries, cash_flow_categories, cash_flow_recurring, forecast_starting_balance, forecast_inflow_overrides, receivables, boletos_mensais, parcelas_cartao, cartoes, fatura_pagamentos
- **Componentes:** CashFlowForm, CashFlowTable, CashFlowCharts, CashFlowForecast, CashFlowWeeklySummary, CashFlowSemaphore, CashFlowCompanySummary, CashFlowReports, BancoSelectionModal (CRUD contas), CashFlowCategoryModal, StoreModal (CRUD lojas + contas), RecurringEntriesModal

### 7.10 `/boletos` — Boletos & Dívidas
- **Tabelas:** boletos_mensais, boleto_categories, boletos_recorrentes, receivables, cartoes, parcelas_cartao, fatura_pagamentos, cash_flow_entries, parcela_tags
- **Página MAIS complexa do ERP**
- **Componentes:** BoletosForm (CRUD com tipo, parcelamento automático, vínculo cartão, geração parcelas), BoletosTable (ações: pagar via banco/cartão, editar, excluir, status, NF), BoletosSummary, BoletosCharts, CartaoBancoSummary, CashFlowSyncPanel, CashFlowProjectionChart, ConsolidatedReport, DailyProjectionTable, FaturasCartaoTable, ParcelasFuturasTable, ParcelamentoDashboard, RankingCategoriasCartao, ReceivablesBlock, RelatorioCartao (5 abas), RecurringTemplatesModal, BoletosCategoriesModal, CartoesModal, EditarParcelaModal, VencimentosCalendar, FinancialDecisionCards, HistoricoPagamentos

### 7.11 `/projecao-caixa` — Projeção de Caixa
- **Tabelas:** receivables, boletos_mensais, parcelas_cartao, expenses, cash_flow_entries, cash_flow_recurring, forecast_starting_balance, sales_entries, monthly_closing, monthly_goals, manual_cash_flow_values
- **Componentes:** KpiCards, ProjectionTable, CashFlowChart, ProjectionInputs, ProjectionInsights, ProjectionPeriods, SmartAlerts, BreakEvenCard, BreakEvenGoalCard, DailyProjectionTable, DailyTableSummaryCard, RevenueScenarioSimulator, HeatmapMatrix, CostSummaryCards, AnnualComparisonChart, ManualCashFlowInput, EventDetailsModal

### 7.12 `/tarefas` — Tarefas (Kanban)
- **Tabelas:** tasks, task_results, task_result_history, users
- **Componentes:** KanbanBoard (colunas: backlog/andamento/concluído), TaskCard (drag-and-drop), TaskForm (CRUD: título, descrição, responsável, prioridade, recorrência, deadline, checklist), FinishTaskModal, RegisterResultModal, PendingResultAlert, AlertCard, AlertForm, AlertPerformancePanel, AlertEmailConfig, DisciplineScore

### 7.13 `/tarefas/resultados-pendentes` — Resultados Pendentes
- **Tabela:** task_results
- Lista de resultados aguardando revisão, ações de aprovar/rejeitar

### 7.14 `/tarefas/banco-resultados` — Banco de Resultados
- **Tabela:** task_results
- Histórico completo com busca/filtro

### 7.15 `/tarefas/alertas-diarios` — Alertas Diários
- **Tabelas:** daily_alerts, daily_alert_logs
- Gestão de checklist diário: criar, marcar feito/ignorado, tracking

### 7.16 `/tarefas/agenda` — Agenda
- **Tabela:** appointments
- **Componentes:** AgendaCalendar (interativo), AppointmentForm (CRUD), AgendaLeftPanel (mini calendário + lista), AgendaRightPanel (detalhes)

### 7.17 `/conciliacao-bancaria` — Conciliação Bancária
- **Tabelas:** bank_reconciliation_batches, bank_reconciliation_entries, cash_flow_entries, stores, cash_flow_categories
- **Componentes:** ReconciliationSummaryCards, ReconciliationTable, BatchSelector, ComparisonTable, DivergenceReport, ImportExtratoModal (upload CSV/OFX), CreateCashFlowModal

### 7.18 `/compras-cmv` — Compras
- **Tabelas:** compras_cmv, compras_xml, auditoria_xml_importacao, produtos_cmv, itens_compra_cmv, historico_custo_cmv, fornecedores_cmv, boletos_mensais, boleto_categories, sales_entries, parcelas_cartao
- **Storage buckets:** `xml-notas`, `produtos-cmv`
- **9 abas:** Compras, XML Fiscal, NFE Entradas, Relatórios, Relatórios NFE, Fechamento, Comparação, Conciliação, Acesso Contador
- **Componentes:** ComprasSimpleForm (registro rápido), ComprasSimpleTable, ComprasSummaryCards, ComprasResumoInferior, FornecedorPieChart, FornecedorTimelineChart, TopFornecedores, ComprasVsBoletosChart, EmpresasPieChart, ImportarXmlModal (upload → parse XML → verifica duplicidade → salva em 3 tabelas), VisualizarXmlModal, VincularNfeModal, EditCompraModal, DeleteCompraModal, MapaFiscalBrasil, CostSparkline, CompraForm, CompraModal, ComprasTable, CadastrarItemModal, CmvAlertas, CmvOverviewTable, CmvSummaryCards, ComprasComparacao, ComprasRelatorios, ConciliaoNfeTab, DivergenciaNfeTab, FechamentoMensalCompras, FornecedorModal, FornecedorRankingProdutos, FornecedorReport, FornecedoresTable, HistoricoPrecoChart, NfeEntradasTab, PainelContadorTab, ProdutoModal, ProdutosCmvTable, RelatoriosDetalhadosTab, XmlFiscalTab, AcessoContadorTab

### 7.19 `/backup` — Backup
- **Tabelas:** backups, sales_entries, expenses, expense_categories, cash_flow_entries, stores
- **Componentes:** BackupStats, BackupList, BackupCreateModal (fotografa 6 tabelas em JSON), BackupRestoreModal (limpa + reinsere)

### 7.20 `/fechamento-mensal` — Fechamento Mensal
- **Tabelas:** sales_entries, expenses, expense_categories, cash_flow_entries, boletos_mensais, monthly_goals, monthly_closing
- **Componentes:** MonthGrid (grid meses com status aberto/fechado), SummaryCards, HistoryTable, ClosingModal (wizard 2 passos), MonthCloseReport

### 7.21 `/capital-giro` — Capital de Giro
- **Tabelas:** produtos_cmv, receivables, boletos_mensais, ecom_sales
- **Componentes:** KpiCards (PMR, PMP, Ciclo de Caixa, NCG), EstoqueTable, ReceivablesTable, PayablesTable, ResumoFinanceiro

### 7.22 `/ecom-estoque` — Vendas & Estoque
- **Tabelas:** ecom_products, ecom_stores, ecom_inventory, ecom_sales, ecom_purchase_config, ecom_conversion, ecom_inventory_movements, boletos_mensais
- **Componentes:** StockTable (alertas mínimo), EcomDashboardCards, SalesInputForm (baixa automática estoque), SalesExcelImport, SalesReport, SalesRanking, ConversionForm, ConversionTab, InventoryAdjustModal, MinStockConfigModal, PurchaseOrderTab, AdsPerformanceTab, SkuAnalysisTab (gráficos + rentabilidade), StoreModal, SkuDetailModal, SkuHistoryModal, SkuAnalysisModal, SkuConversionModal, AdDetailModal

### 7.23 `/erp-ml` — ERP Mercado Livre
- **Tabelas:** system_settings, ml_accounts, ml_orders, ml_sync_logs, ml_items, ml_alertas_promocao
- **Sidebar vertical** com navegação entre abas
- **Abas:** Dashboard, Vendas, VendasOnline (analytics), Financeiro, Performance (anúncios), Promocoes, PromocoesMercadoLivre, IaSocio (chat AI + recomendações + executivo), Alertas (estoque/preço), Estoque, ReposicaoFull (motor reposição + dashboard + rankings + tabela avançada + alertas), Configuracoes (API + OAuth)
- **Edge Functions:** `ml-oauth` (OAuth token exchange), `erp-api-proxy` (proxy API ML), `ai-assistant-chat` (chat IA), `send-ml-promo-alerts`

### 7.24 `/usuarios` — Gestão de Usuários (admin only)
- **Tabelas:** users, access_logs, user_permissions
- Lista de usuários com busca, CRUD (nome, email, senha, role, ativo/inativo)
- **Matriz de permissões** — grid checkbox por página (can_access, can_edit, can_delete)
- Log de acessos (IP, data, sucesso/falha)

### 7.25 `/dashboard` — Painel Admin
- **Tabelas:** users, backups, admin_notices
- **Componente:** AdminNoticesPanel (CRUD avisos administrativos)

### 7.26 `/notas-atualizacao` — Notas de Atualização
- **Tabela:** release_notes
- Lista de changelog com versão, data, descrição
- AddReleaseModal, DeleteConfirmModal

### 7.27 `*` — 404
- Página estática de "não encontrado", sem banco

---

## 8. REGRAS DE NEGÓCIO CRÍTICAS

### 8.1 Margem de Contribuição
```typescript
Margem = gross_revenue - marketplace_fees - subsidized_shipping - cogs - ads_ml - ads_external - tax
Margem % = (Margem / gross_revenue) * 100
```

### 8.2 Semáforo de Margem
- > 25% → excellent (verde escuro)
- 20-25% → great (verde)
- 15-20% → good (verde claro)
- 10-15% → acceptable (amarelo)
- 5-10% → concerning (laranja)
- 0-5% → veryLow (vermelho)
- < 0% → critical (vermelho escuro / prejuízo)

### 8.3 DRE Automático
```
Receita Bruta
(-) Taxas Marketplace
(-) Frete Subsidiado
(-) CMV
(-) Ads ML
(-) Ads Externos
(-) Impostos
(=) Lucro Bruto
(-) Despesas Fixas
(-) Despesas Operacionais
(=) Lucro Líquido
```

### 8.4 Break-Even Point
```
Ponto de Equilíbrio = (Custos Fixos + Custos Operacionais) / (Margem de Contribuição %)
```
- Status: verde (≥100%), amarelo (≥80%), vermelho (<80%)

### 8.5 Projeção (Run Rate)
```
Run Rate = Média diária de receita × dias do mês
Comparado com a meta mensal (monthly_goals)
Status: ahead (>105%), risco (95-105%), atrasado (<95%)
```

### 8.6 Boletos — Pagamento
- Ao pagar um boleto: atualiza status para 'pago' + insere em `cash_flow_entries` (type='expense') + se for parcela de cartão, insere em `fatura_pagamentos`

### 8.7 Despesas Recorrentes
- Ao abrir um novo mês, despesas com `is_recurring = true` de meses anteriores são automaticamente replicadas

### 8.8 Importação de XML (NF-e)
- Upload para bucket `xml-notas` no Supabase Storage
- Parse do XML → extrai chave NF-e (44 dígitos), dados fiscais, itens
- Verifica duplicidade em `compras_xml` por chave NF-e
- Se nova: insere em `compras_cmv` + `compras_xml` + `auditoria_xml_importacao`
- `diferenca_nfe` = valor_nfe - valor_pago

### 8.9 Backup
- Fotografa dados de 6 tabelas: sales_entries, expenses, expense_categories, cash_flow_entries, stores (e outras)
- Salva JSON completo em `backups.data`
- Restauração: limpa tabelas e reinsere do JSON

### 8.10 Fechamento Mensal
- Wizard 2 passos:
  1. Confirma dados do mês (vendas, despesas, caixa, boletos, meta)
  2. Salva snapshot completo em `monthly_closing`

---

## 9. EDGE FUNCTIONS (SUPABASE)

| Slug | Função | Descrição |
|---|---|---|
| `send-boletos-reminder` | Email | Lembretes de boletos a vencer |
| `send-forecast-email` | Email | Relatório de projeção de caixa |
| `forecast-scheduler` | Scheduler | Dispara forecast email diariamente 8h Brasília |
| `send-daily-alerts-summary` | Email | Resumo diário de alertas 21h |
| `manage-alert-email-schedule` | Config | Gerencia schedule dos emails de alerta |
| `send-appointment-email` | Email | Notificação de compromissos da agenda |
| `send-login-alert` | Email | Alerta de tentativas de login falhas |
| `send-monthly-closing-email` | Email | Relatório de fechamento mensal |
| `send-password-reset-email` | Email | Link de reset de senha |
| `send-ml-promo-alerts` | Telegram | Alertas de promoções ML via Telegram |
| `reset-password` | Auth | Reseta senha do usuário |
| `setup-admin` | Admin | Configura usuário admin inicial |
| `update-admin-password` | Admin | Atualiza senha do admin |
| `ai-assistant-chat` | AI | Chat com IA (usado no módulo ERP ML) |
| `ml-oauth` | OAuth | Token exchange OAuth Mercado Livre |
| `erp-api-proxy` | Proxy | Proxy para API do Mercado Livre |
| `reset-admin-password-temp` | Admin | (desativada) |
| `reset-suelen-password` | Admin | (desativada) |

---

## 10. UI/UX PADRÕES

### 10.1 Cores do Tema
- Sidebar: `bg-slate-900` (fundo escuro)
- Conteúdo: `bg-slate-50` (fundo claro)
- Cor primária (destaque): `emerald-500` (verde)
- Texto principal: `text-slate-800`
- Texto secundário: `text-slate-400`, `text-slate-500`
- Cards: fundo branco com `rounded-lg`
- Status verde: `text-emerald-500`, `bg-emerald-50`
- Status vermelho: `text-red-500`, `bg-red-50`
- Status amarelo: `text-amber-500`, `bg-amber-50`

### 10.2 Tipografia
- Font: **Inter** (Google Fonts, 300-800 weights)
- Tamanhos: títulos 14-16px, corpo 12-14px, labels 10-12px
- Monospace para números financeiros

### 10.3 Componentes Padrão
- **Cards KPI:** fundo branco, borda sutil (`border border-slate-200/60`), padding `p-4`, `rounded-lg`
- **Tabelas:** header `bg-slate-50 text-slate-500 text-xs font-medium uppercase`, rows com hover `hover:bg-slate-50`
- **Modais:** overlay `bg-black/40`, card centralizado `bg-white rounded-2xl shadow-xl max-w-[tamanho] w-full`
- **Botões primários:** `bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg font-medium`
- **Botões secundários:** `border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg`
- **Inputs:** `border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500`
- **Badges:** `rounded-full px-2 py-0.5 text-xs font-medium`
- **Tabs/Segmented Control:** `flex bg-slate-100 rounded-full p-1`, botões `rounded-full px-4 py-1.5`

### 10.4 Animações CSS (definidas em index.css)
- `animate-fade-in-up` — fade in de baixo
- `animate-fade-in` — fade in simples
- `animate-scale-in` — scale de 0.95 para 1
- `animate-bounce-in` — bounce suave
- `animate-overdue` — pulsar borda vermelha para itens atrasados
- `animate-dot-overdue` — ponto pulsante vermelho
- `animate-shake` — shake horizontal (ícones)

### 10.5 Ícones
- **Remix Icon:** classes `ri-*` (ex: `ri-store-2-line`, `ri-bill-line`) — CDN em index.html
- **Font Awesome:** classes `fa-*` — CDN em index.html (pouco usado)

### 10.6 Layout
- **MainLayout:** sidebar fixa à esquerda (56 colapsada / 224 expandida) + conteúdo com `ml-16` ou `ml-56`
- Sidebar é colapsável (toggle), estado persistido via `useSidebarCollapse`
- Todas as páginas usam `MainLayout` como wrapper

---

## 11. CONFIGURAÇÕES CRÍTICAS

### 11.1 Variáveis de Ambiente (.env)
```
VITE_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
```

### 11.2 Globais Vite (injetados via define)
- `__BASE_PATH__` — base path do router (ex: `"/"`)
- `__IS_PREVIEW__` — flag de preview
- `__READDY_PROJECT_ID__` — ID do projeto
- `__READDY_VERSION_ID__` — ID da versão (exibido na sidebar)
- `__READDY_AI_DOMAIN__` — domínio AI

### 11.3 Tailwind Config
- **NÃO** há customização no `theme.extend` — usa apenas classes padrão do Tailwind + cores arbitrárias (ex: `bg-slate-50`, `text-emerald-500`)

### 11.4 Supabase Client
- Singleton lazy via Proxy pattern em `src/lib/supabase.ts`
- Inicializa na primeira chamada de método
- Exporta `supabase` como objeto proxy

---

## 12. FLUXO DE CRIAÇÃO DO SISTEMA (ORDEM RECOMENDADA)

1. **Inicializar projeto Vite + React + TypeScript + TailwindCSS**
2. **Configurar variáveis de ambiente** (Supabase URL/Key)
3. **Criar Supabase client** (`src/lib/supabase.ts` — singleton lazy)
4. **Criar tabela `users`** e implementar auth customizada (`useAuth.ts`)
5. **Criar rotas e layout base** (BrowserRouter, ProtectedRoute, MainLayout, Sidebar)
6. **Criar página de Login** (com hash customizado)
7. **Criar tabelas core** (sales_entries, stores, monthly_goals)
8. **Criar módulo Vendas** — o coração do sistema
9. **Criar módulo Despesas** (expenses, expense_categories) — alimenta DRE
10. **Criar módulo DRE** — integra vendas + despesas
11. **Criar módulo Fluxo de Caixa** (cash_flow_entries, contas)
12. **Criar módulo Boletos** (boletos_mensais, cartoes, parcelas_cartao) — o mais complexo
13. **Criar módulo Projeção de Caixa** — usa dados de todos os anteriores
14. **Criar módulo Compras** (compras_cmv, XML, NF-e)
15. **Criar módulo Home** — painel que agrega tudo
16. **Criar módulos complementares** (Tarefas, Agenda, Conciliação, Backup, Fechamento, Capital de Giro)
17. **Criar módulo E-commerce Estoque**
18. **Criar módulo ERP ML** (integração Mercado Livre)
19. **Criar Edge Functions** conforme necessidade
20. **Adicionar exportação** (PDF, Excel, CSV) em cada módulo

---

## 13. NOTAS IMPORTANTES PARA O CLONE

### O que NÃO fazer:
- ❌ NÃO usar Supabase Auth nativo (`.auth.signIn()`) — auth é 100% customizada
- ❌ NÃO usar React Query (@tanstack/react-query está na lista mas não é usado)
- ❌ NÃO usar Firebase (está no package.json mas não é usado no core)
- ❌ NÃO usar Stripe (está no package.json mas não é usado)
- ❌ NÃO criar múltiplas instâncias do Supabase client — usar singleton
- ❌ NÃO usar `../` nos imports — sempre `@/`
- ❌ NÃO usar cores azul ou roxo como primárias (design decidiu emerald)
- ❌ NÃO usar `React.xxx` — sempre importar APIs nomeadas

### O que SEMPRE fazer:
- ✅ Validar autenticação em TODAS as páginas protegidas
- ✅ Usar `maybeSingle()` ao invés de `single()` nas queries
- ✅ Tratar erros com try/catch e mostrar mensagens ao usuário
- ✅ Mock data para desenvolvimento (arquivos em `src/mocks/`)
- ✅ Exportação em múltiplos formatos (PDF, Excel, CSV)
- ✅ Animações sutis para feedback visual
- ✅ Mobile responsive (sidebar colapsa, tabelas com scroll horizontal)

---

## 14. EXPORTAÇÕES POR MÓDULO

Todos os módulos principais implementam exportação em:
- **Excel (.xlsx):** via biblioteca `xlsx` (SheetJS)
- **CSV:** com BOM para encoding correto
- **PDF:** via `jspdf` + `jspdf-autotable`

Arquivos de export em: `src/pages/[modulo]/utils/export*.ts`

---

**Fim do documento.**
Use estas informações para recriar o sistema do zero, seguindo a ordem recomendada na seção 12.