# Módulos do Sistema

> Escopo: a organização do sistema em **módulos** — cada um com seu próprio menu lateral, como se fosse um sistema separado. Troca-se de módulo pelo **switcher no topbar** (`.module-switcher`). Para o frontend estático em si ver `frontend.md`; para os marketplaces (que são "sub-sistemas" dentro do Operacional) ver `frontend.md`/`shopee.md`/`amazon.md`.

## Os 3 módulos

| Módulo | O que é | Menu lateral | Fonte de dados |
|---|---|---|---|
| **Operacional** | O sistema atual completo (ML + Amazon + Shopee, rankeamento, embalagem, conciliação, etc.) | `js/layout.js` (`NAV_ITEMS`) — e os layouts próprios de Amazon/Shopee dentro dele | Postgres principal (`db/pool.js`) |
| **Financeiro** | Controle financeiro (em construção) | `js/layout-financeiro.js` (`FIN_NAV_ITEMS`) | **Supabase separado** (banco já existente de outra ferramenta — ver abaixo) |
| **Inteligência de Negócio** | Análises estratégicas (em construção) | `js/layout-bi.js` (`BI_NAV_ITEMS`) | a definir |

Hoje **Financeiro** e **Inteligência de Negócio** têm só a página "em construção" (`pages/financeiro.html`, `pages/inteligencia-negocio.html`). O Operacional está 100% pronto.

## Como funciona a troca de módulo

- Cada módulo tem seu **layout próprio** (sidebar + topbar), mesmo padrão de `js/layout-amazon.js`/`js/layout-shopee.js`: a página tem `<div id="app-sidebar">`/`<div id="app-topbar">` e o layout injeta o menu no `DOMContentLoaded`.
- O **switcher de módulos** (`buildModuleSwitcher`, classe CSS `.module-switcher`) fica no `topbar-left` e leva a `../index.html` (Operacional), `financeiro.html` e `inteligencia-negocio.html`. Está replicado em `layout.js`, `layout-financeiro.js` e `layout-bi.js` (mesmo motivo do switcher de marketplace ser replicado — cada layout monta seu próprio topbar) e também inline no `index.html` (topbar da raiz).
## Autorização de módulos (implementado)

Fonte de verdade: o objeto **`MODULES`** em `server/src/routes/staffAuth.js` — mapeia cada módulo para os papéis que podem acessá-lo, mais as `pages`/`apiPrefixes` que pertencem a ele:

```js
const MODULES = {
  operacional: { roles: '*' },                          // todos os papéis logados
  financeiro:  { roles: ['admin'], pages: ['/pages/financeiro.html'], apiPrefixes: ['/api/financeiro'] },
  bi:          { roles: ['admin'], pages: ['/pages/inteligencia-negocio.html'], apiPrefixes: ['/api/bi'] },
};
```

Hoje **Financeiro e Inteligência de Negócio são só `admin`**. Para autorizar um papel novo, mudar quem vê um módulo, ou adicionar um módulo, **edita-se só esse objeto** — nada mais.

Como é aplicado:
- **Backend (gate real)**: `requireStaffAuth` chama `restrictedModuleForPath(path)`; se o path é de um módulo restrito e o papel não está autorizado, bloqueia (`403` em API) ou redireciona pra `/` (página). Vale pra qualquer papel.
- **Frontend (UX)**: `GET /auth/staff/me` devolve `modules: [...]` (chaves autorizadas). `applyModuleAuth()` em `js/layout.js` **remove do switcher** os botões de módulo não autorizados (inclui o switcher inline do `index.html`, via `data-module`). Se o gate estiver desligado (`modules` ausente), não esconde nada.

Papéis restritos legados (`embalagem`, `shopee-demo`) continuam com suas próprias regras (redirecionados antes de chegar ao gate de módulo).

## Módulo Financeiro — banco Supabase (implementado, READ-ONLY)

O Financeiro lê de um **Supabase existente** (projeto "Sistema de Gestão Financeira E-commerce", dados reais de outra ferramenta — **nada pode ser perdido**). Como está feito:

- **Cliente isolado** `server/src/db/supabaseFin.js` — REST (PostgREST `/rest/v1`). Leitura por GET (lista tabelas, prévia, `selectRows`). **Escrita habilitada por allowlist** (`WRITE_ALLOW`, hoje só `sales_entries`): `insertRow`/`updateRow`/`deleteRow` via POST/PATCH/DELETE, `Prefer: return=representation`, update/delete por `?id=eq.<id>`. Qualquer tabela fora da allowlist responde 403. Distinto do `db/pool.js`; `migrate.js` **nunca** aponta pra cá.
- **Config** em `env.financeiro` (`SUPABASE_FIN_URL` + `SUPABASE_FIN_KEY`, do `.env` do servidor). Sem elas o módulo responde "não configurado". A chave pode ser `anon` (respeita RLS) ou `service_role` (ignora RLS — só no servidor).
- **Rotas** `/api/financeiro/*` (montadas em `server.js`, **só admin** via MODULES): `GET /status`, `GET /tabelas`, `GET /tabela/:nome?limit` (prévia ≤200), `GET /dados/:nome?limit&order` (leitura ≤5000). Escrita (allowlist): `POST /dados/:nome`, `PATCH /dados/:nome/:id`, `DELETE /dados/:nome/:id`. Métodos espelho em `js/db.js` (`getFinanceiroStatus/Tabelas/Tabela/Dados`, `addFinanceiroRow/updateFinanceiroRow/deleteFinanceiroRow`).
- **Página** `pages/financeiro.html` = **explorador**: mostra status da conexão, lista as tabelas do Supabase e a prévia de cada uma. Serve pra descobrir o schema real (o ambiente de dev não tem egress pro Supabase, então a validação acontece no deploy).
- **Rede**: o servidor de produção precisa de egress pro Supabase (443 REST). Os dois bancos **não se juntam em SQL** — cruzamento ML×Financeiro é na aplicação.

## Clone do ERP FinanceEcom (Readdy) — referência mestra

O usuário está **migrando** um ERP financeiro (feito no Readdy, React) para cá. A migração agora **grava neste sistema** (não só lê): a escrita é habilitada tela a tela via `WRITE_ALLOW` (a 1ª foi `sales_entries`, pelo formulário "Novo Lançamento Diário" da tela Vendas). **Manter o tema ESCURO e o layout atual do dashboard** — clonar só a **funcionalidade/cálculos**, não o visual claro do Readdy. **A escrita exige a chave `service_role` (`sb_secret`) em `SUPABASE_FIN_KEY`** — com a `publishable` o Supabase recusa por RLS.

- **Memória permanente do ERP**: `.claude/financeiro-clone-guide.md` (guia completo: 28 rotas, componentes, regras) e `.claude/financeiro-supabase-schema.md` (schema real das ~60 tabelas). **Consultar sempre** antes de construir uma tela do Financeiro.
- **Empresas/lojas**: UNIFULL, TOP MIX, R SOUZA, SHOPEE. Campo `empresa` (text) em boletos/receivables/compras; `store_id` (uuid) na maioria.
- **Fórmulas-chave**: Margem contribuição = `gross_revenue − marketplace_fees − subsidized_shipping − cogs − ads_ml − ads_external − tax`. Semáforo margem: >25 verde, 15-25 amarelo, <15 vermelho, <0 prejuízo. Projeção (run rate) = média diária × dias do mês; status ahead>105% / risco 95-105% / atrasado<95%. Break-even = (custos fixos+operacionais) / margem%. DRE: receita → (-)deduções → (-)CMV → lucro bruto → (-)despesas → lucro líquido.
- **Ordem das telas**: Vendas ✅ → Despesas & DRE → DRE → Fluxo de Caixa → Boletos → Projeção → Compras → Home → resto.

### Telas reais (read-only) — em construção

- **Vendas & Custos** (`pages/financeiro-vendas.html`, nav `Vendas & Custos`): lê `sales_entries` + `stores` + `monthly_goals`. **Funcionalidade fiel ao Readdy** (tema escuro nosso): **Meta de Faturamento** (11 cards — Realizado D-1, Meta, Meta Restante, Gap Projeção, Velocidade Média, Projeção Mês, Meta do Dia, Ontem, Pior Dia, Meta Mínima, Dia Ideal — via porta do `useGoalCalculations`), barra de progresso + status ahead/risco/atrasado; **Metas por Empresa** (card por loja: realizado/meta/%/projeção/ritmo/margem); **Indicadores do Período** (Receita, MC, Vendas, Ticket + variação vs mês ant.); **Meta Diária** (dia a dia com semáforo Passou/Faltou, meta = goal/dias); **Composição da Receita Bruta** (donut + 7 cards: Taxas MP/Frete/CMV/Ads ML/Ads Ext./Imposto/Margem, cada um % sobre a receita); **Evolução Diária da Margem %** (linha + média tracejada + badges Média/Melhor dia/Pior dia + zonas + nota de tendência p.p. + tooltip com Margem %/Margem R$/Rec. Bruta); **Comparativo por Empresa** (barras agrupadas receita/custos/margem por loja); **Composição dos Custos** (donut + abas Todas/por-loja, cards CMV/Frete/Tarifas/Imposto/Ads/Margem % sobre a receita); **Volume vs. Rentabilidade** (combo por lançamento: barras Rec. Bruta cinza + Margem R$ verde/vermelha + linha Margem % no eixo direito, badges Total Rec./Total Margem/% geral, cards Maior volume/Maior margem R$). **Formulário "Novo Lançamento Diário"** (escrita): grava uma linha em `sales_entries` (data, qtd, receita, taxas, frete, CMV, ads ML, ads externos, imposto, loja) — 1ª tela com escrita da migração. **Ao clicar "Lançar" abre um modal de confirmação** (empresa + data + valores + margem calculada) para evitar lançamento errado. **Tabela "Histórico de Lançamentos"** (linha a linha por empresa, respeita filtros mês/ano/loja) com botões **editar** (corrigir data/valores → `updateFinanceiroRow`, PATCH `?id=eq.`) e **excluir** (com confirmação → `deleteFinanceiroRow`); borda esquerda colorida pelo semáforo de margem. Tudo reflete na tela sem recarregar.
- Meta geral = linha de `monthly_goals` com `store_id` NULL (igual ao Readdy `MonthlyGoal`); nunca soma das metas por loja (evita duplicar). Fallback: se não houver linha geral, soma as por-loja.
- Rotas: `GET /api/financeiro/dados/:nome?limit&order` (≤5000, order `col.asc|desc`) + `POST/PATCH/DELETE /api/financeiro/dados/:nome[/:id]` (allowlist). `js/db.js`: `getFinanceiroDados`, `addFinanceiroRow`.

- **Despesas & DRE** (`pages/financeiro-despesas.html`, nav `Despesas & DRE`): lê `expenses` + `expense_categories` + `sales_entries`. **2 abas**: "DRE & Despesas" e "Ponto de Equilíbrio". Escrita (allowlist) em `expenses` e `expense_categories`. Conteúdo (clone fiel do Readdy, tema escuro):
  - **Lançamentos do mês** = custos "Auto" das vendas (Receita Bruta como entrada; Taxas/Frete/CMV/Ads/Impostos como custo — não editáveis, vêm da tela Vendas) **+** despesas manuais (editáveis/excluíveis). `expenses` tem colunas `type` ('fixed'/'operational'), `description`, `category_id`, `value`, `date`, `is_recurring`, `month`, `year`, `store_id`.
  - **Nova Despesa**: tipo (segmented Fixo/Operacional), categoria, descrição, valor, recorrente — com **modal de confirmação**. Competência = mês/ano selecionados.
  - **DRE Detalhada**: cascata Receita → custos automáticos → Margem de Contribuição → despesas fixas/operacionais → Lucro Líquido, + cards-resumo à direita (Receita, MC com barra, Total Despesas, Lucro Líquido/Prejuízo) + badge de status da margem.
  - **DRE Resumida anual** (painel lateral): Entradas/Custos/Resultado por mês + totais.
  - **Custo por Categoria** (donut + lista rankeada com % e barras, filtro Todos/Fixos/Operacionais).
  - **Tendência** (barras gastos × linha faturamento, 3M/6M/12M + cards mensais com % do faturamento).
  - **Comparativo Mês a Mês por Categoria** (tabela com variação % + Δ absoluto vs mês anterior, "novo" na 1ª aparição).
  - **Ponto de Equilíbrio** = (custos fixos+operacionais) ÷ margem de contribuição %; **a margem usa os últimos 30 dias de vendas** (não o mês). **Ranking de Impacto no Break-even**: quanto cada categoria reduz o break-even se eliminada (= custo ÷ margem%), + destaque "Maior alavanca de redução".
  - Ações: Exportar CSV, Categorias (CRUD categorias), Recorrentes (lista), Limpar Despesas (só as manuais do mês, com confirmação).
- Escrita liberada: `WRITE_ALLOW` em `supabaseFin.js` = `sales_entries`, `expenses`, `expense_categories`.

- **DRE — Resultado** (`pages/financeiro-dre.html`, nav `DRE — Resultado`): read-only, lê `sales_entries` + `expenses` + `expense_categories` (mesmas 3 tabelas). Seções (clone fiel do `/dre` do Readdy, tema escuro):
  - **Visão Anual**: 12 cards de mês (receita + resultado, mês atual destacado) clicáveis para trocar o mês do DRE; + Receita Anual / Custos Totais / Lucro Acumulado.
  - **Comparativo** mês vs mês anterior: cards Período, Receita Total, Saída Total, Margem Contrib. (badge de status), Lucro Líquido (badge Prejuízo/Atenção), cada um com % de variação + mini-sparkline SVG (últimos 6 meses).
  - **DRE completa**: cascata Receita → custos operacionais (cada linha com % da receita) → Total Custos Op. → Margem de Contribuição → Despesas (cada despesa individual) → Total Despesas → Lucro Líquido; + **Composição da Receita** (barras) + boxes Total Custos / Resultado.
  - **Projeção Anual**: método **Média 3 meses / Tendência linear (regressão) / Último mês**; cards Receita/Custos/Lucro projetados (fechado vs projetado) + médias mensais; gráfico Receita×Lucro por mês; **Detalhamento Mensal** (tabela com status Fechado/Estimado/Projetado + Total do ano com selo Crítico/Saudável).
  - Ações: Atualizar, **Exportar Excel** (.xls via HTML table) e **Exportar PDF** (janela de impressão).

- **Boletos** (`pages/financeiro-boletos.html`, nav `Boletos`): contas a pagar do mês. Lê/grava `boletos_mensais` + `receivables` + `cartoes` + `boleto_categories`. Filtro por empresa (UNIFULL/TOP MIX/R SOUZA/SHOPEE)/mês (`mes_referencia` 'YYYY-MM')/status; **tabs por tipo** (boleto/cartão/imposto/pessoal/fatura ML/flex/custo fixo/variável). KPIs (Total/Pago/Pendente/Atrasado — "atrasado" = pendente com `date` < hoje). **Form "Cadastrar Dívida"** (fiel ao Readdy): tipo segmentado (8), Vencimento/Categoria/Fornecedor/Empresa(+chips)/NF(`numero_nf`, grava só se preenchido)/Nome/Valor/Status segmentado. **Fluxo não-cartão** = 1 INSERT em `boletos_mensais` (`is_origem:true`). **Fluxo cartão** = bloco extra (cartão + parcelas 1-24 + valor total, mostra "Nx de R$Y") → INSERT dívida-mãe (`tipo:'cartao'`,`valor_total`,`numero_parcelas`,`cartao_id`) + N `parcelas_cartao` com vencimentos pela **regra de cartão** (`calcVencimentos`: compra ≤ dia de fechamento → 1ª parcela na fatura do mês, vence no seguinte; depois do fechamento → começa na fatura seguinte). **Gerenciar Cartões** (CRUD `cartoes` + ativar/excluir) e **Recorrentes** (CRUD `boletos_recorrentes` + "Gerar {mês}" pulando duplicatas). Tabela com coluna NF, pagar (toggle `status`)/editar/excluir. **Resumo por Empresa** (total/pago/resta) + **Calendário de Vencimentos** (grade do mês com bolinhas pendente/pago/recebível + cards Total Boletos/Recebíveis/Atrasados/Saldo do Mês). Bloco de Recebíveis e Cartões (CRUD `cartoes`). CSV.
- **Recebíveis** (`pages/financeiro-recebiveis.html`, nav `Recebíveis`): lê/grava `receivables`. Agrupado por dia (total + quebra por empresa), abas Todos/Pendentes/Recebidos, filtro empresa/mês, cadastro inline, marcar recebido (toggle `recebido`/`data_recebimento`), CSV/PDF. Regra: só pendentes contam nos indicadores.
- **Relatório de Cartão** (`pages/financeiro-cartoes.html`, nav `Relatório de Cartão`): centro de controle de cartão de crédito. Lê/grava `parcelas_cartao` (principal) + `cartoes` + `boletos_mensais` (compras) + `parcela_tags` + `fatura_pagamentos`. Filtros globais: mês (`fatura_mes`) + chips de cartão (multi-seleção). **6 sub-abas**: (1) **Cards por Cartão** — card expansível por cartão com status da fatura atual (aberta/fechada/vencida/paga), valores (total/pago/aberto), barra de limite, histórico de faturas expansível (parcela a parcela), botão **Pagar Fatura** (marca todas pendentes + INSERT `fatura_pagamentos`), editar limite, toggle parcela; (2) **Visão Geral** — 4 KPIs (Comprometido/Aberto/Pago/Nº Compras), gráfico gasto por cartão (barras↔pizza), limite usado×disponível (barras empilhadas), comprometimento mensal; (3) **Por Cartão** — tabela drill-down por cartão + editar parcela; (4) **Categorias** — ranking por categoria da compra; (5) **Parcelas Futuras** — agrupadas por fatura, vencidas com badge VENCIDA, filtro status, atribuir tag, toggle/editar; (6) **Tags** — CRUD de tags (cores automáticas), stacked bar por mês, matriz tag×mês, distribuição, CSV/PDF. Escrita: toggle status, pagar fatura, editar limite/parcela, tag_id, CRUD tags.
- Escrita liberada agora: `WRITE_ALLOW` += `boletos_mensais`, `receivables`, `boleto_categories`, `cartoes`, `parcelas_cartao`, `parcela_tags`, `fatura_pagamentos`.
- **Simplificação v1 Cartão:** excluir compra (que deveria DELETE `parcelas_cartao`+`cash_flow_entries`+`boletos_mensais`) ainda não implementado aqui; o "Pagar Fatura" faz INSERT `fatura_pagamentos` + UPDATE parcelas, mas não atualiza `boletos_mensais` da dívida-mãe ainda.
- **Simplificações v1 (a refinar):** a sincronização automática boleto↔`cash_flow_entries` (deletar/inserir ao pagar) **não** é feita aqui ainda; templates recorrentes (`boletos_recorrentes`) e parcelas de cartão (`parcelas_cartao`) não têm CRUD próprio ainda; escrita de NF depende do nome real da coluna em `boletos_mensais` (só exibe hoje).

Schema real das tabelas do ERP (via Readdy): `sales_entries`, `expenses`, `expense_categories`, `boletos_mensais`, `receivables`, `cartoes`, `compras_cmv`, etc. — próximas telas: **Fluxo de Caixa**, **Compras** (`compras_cmv`), **Home** (10 tabelas: sales_entries, cash_flow_entries, boletos_mensais, expenses, receivables, monthly_goals, daily_alerts, daily_alert_logs, compras_xml, backups).
