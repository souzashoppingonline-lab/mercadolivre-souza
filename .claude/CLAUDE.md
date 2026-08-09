# Memória Permanente do Projeto — `.claude/`

Esta pasta é a documentação modular e viva do projeto **ML Dashboard Multimarcas**. Ela é tratada como código: entra em commit, é revisada, e é atualizada na mesma tarefa que altera o comportamento que ela descreve.

## Regra obrigatória — leia antes de qualquer tarefa

**Antes de responder qualquer solicitação neste repositório, leia todos os arquivos desta pasta.** Nessa ordem sugerida:

1. `workflow.md` — para saber COMO abordar a tarefa (análise antes de código, padrões nunca aceitos, prioridades do projeto).
2. `architecture.md` — para entender o fluxo de dados e a topologia de processos.
3. Os arquivos específicos da área que a tarefa toca (tabela abaixo).
4. `business-rules.md` e `decisions.md` — para não recriar uma regra ou reverter uma decisão já tomada.
5. `known-bugs.md` e `todo.md` — para saber o que já é gap conhecido, em vez de redescobrir.

Só depois de entender processo + arquitetura + regras de negócio + histórico de decisões, faça alterações. `workflow.md` é obrigatório em toda tarefa, mesmo pequena — nunca escreva código antes de explicar problema, solução, vantagens, riscos e impacto.

## Índice — um arquivo, um assunto, sem repetição entre eles

| Arquivo | Assunto (e só esse assunto) |
|---|---|
| `workflow.md` | Processo obrigatório antes/durante/depois de qualquer alteração: checklist de análise, padrões de qualidade nunca aceitos, verificação de duplicação, objetivos e prioridades do projeto, regra de melhoria proativa |
| `architecture.md` | Fluxo EDA ponta-a-ponta, topologia dos dois processos (server/worker), árvore de diretórios, regras de fronteira entre camadas |
| `modules.md` | Organização em módulos (Operacional/Financeiro/Inteligência de Negócio): switcher de módulos, layouts próprios por módulo, plano do banco Supabase do Financeiro |
| `backend.md` | Processo HTTP Express: `server.js`, `config/env.js`, montagem de rotas, dependências, conexões singleton |
| `frontend.md` | Estrutura estática (HTML/CSS/JS sem build), páginas, `js/db.js`, `js/websocket.js`, `js/layout.js`, contrato para criar página nova |
| `database.md` | Schema PostgreSQL completo (todas as tabelas/colunas/índices), migrations e como aplicá-las |
| `api.md` | Contrato de todo endpoint REST (`/api`, `/api/turbo`, `/webhooks`, `/auth`) |
| `websocket.md` | Hub WS (`ws/hub.js`), cliente WS, catálogo de tópicos publicados/consumidos |
| `redis.md` | Cliente Redis, cache de leitura (`cached()`), canais pub/sub (`ml:ws:broadcast`, `worker:cmd`) |
| `workers.md` | Processo BullMQ: filas por loja, handlers por tópico webhook, jobs agendados, bot Telegram |
| `mercadolivre.md` | OAuth, `mlClient.js`, webhooks recebidos do ML, rate limiting — única integração de marketplace implementada |
| `task-engine.md` | Agenda Trello: `TaskEngine` (geração automática de cartões), regras implementadas/futuras, escopo atual (só ML) |
| `conciliacao-bancaria.md` | Módulo financeiro Pedido→Pagamento→Liberação→Transferência→Conciliação, status por fase, API de Faturamento ML, o que depende do app Mercado Pago |
| `embalagem.md` | Bipagem de etiqueta (FLEX/Mercado Envios), gravação de vídeo de conferência, retenção de 30 dias |
| `rankeamento.md` | Acompanhamento de anúncio na janela de ranqueamento: cada venda/alteração na tela + Telegram, marco a cada N vendas. Tabelas `ranking_ads`/`ranking_events`, `server/src/ranking.js`, rotas `/api/ranking/*` |
| `print-agent.md` | Impressão automática de etiquetas (10×15 térmica) via agente local: `print_stations`/`print_jobs`, rotas `/api/print/*` (gestão) e `/print-agent/*` (agente com token), pasta `print-agent/` |
| `analise-produtos.md` | Módulo de decisão de compra: cadastro de produto+custos, coleta de concorrentes via extensão (fila de "produto ativo"), fases 2/3 (inteligência + IA). Tabelas `analise_products`/`analise_product_ads`/`analise_active_collection`, rotas `/api/analise/*` |
| `auth-staff.md` | Login de acesso restrito para funcionários (papéis admin/embalagem), JWT em cookie, kill switch, mudança de infraestrutura no nginx |
| `shopee.md` | Status (não implementado) e como uma integração Shopee deveria se encaixar na arquitetura |
| `amazon.md` | Status (não implementado) e como uma integração Amazon (SP-API) deveria se encaixar na arquitetura |
| `business-rules.md` | Regras de domínio não óbvias: thresholds de estoque, quando notificar, curva ABC, clientes novos/recorrentes, silêncio do Telegram |
| `finance.md` | Fórmulas de margem/ROI, `orders` vs. `ml_turbo_sales`, mapeamento de colunas da planilha Turbo |
| `deployment.md` | Produção: servidor, systemd, Postgres, nginx WS, lojas conectadas, comandos de diagnóstico |
| `roadmap.md` | Direção futura (multi-marketplace, descomissionamento do sistema antigo, features cogitadas) |
| `known-bugs.md` | Defeitos/gaps reais identificados no código atual, com correção esperada |
| `decisions.md` | Histórico de decisões arquiteturais e trade-offs conscientes ("por que assim e não de outro jeito") |
| `todo.md` | Lista viva de tarefas acionáveis pendentes |

Não repita conteúdo entre esses arquivos — se uma informação já tem dono, referencie o arquivo em vez de copiar.

## Regra obrigatória — mantenha atualizado a cada alteração

A documentação é parte do projeto, não um anexo. Toda tarefa que altera código deve terminar com a documentação correspondente atualizada, **na mesma tarefa**:

- **Nova rota REST** (`server/src/routes/*.js`) → atualizar `api.md` e o método espelho em `js/db.js` (`frontend.md` descreve o contrato dessa camada).
- **Alteração de schema** (`server/src/db/*.sql`) → atualizar `database.md`, e garantir que a migration nova esteja na lista aplicada por `db/migrate.js` (ver `known-bugs.md` item 4 para o que acontece quando isso é esquecido).
- **Novo handler de tópico webhook ou sync agendado** (`server/src/worker.js`) → atualizar `workers.md`.
- **Novo evento WebSocket ou mudança de payload** (`ws/hub.js`, handlers do worker) → atualizar `websocket.md`.
- **Nova página frontend** → atualizar a lista em `frontend.md` e `js/layout.js` (`NAV_ITEMS`).
- **Nova regra de negócio descoberta ou definida** (thresholds, condições de notificação, cálculos) → registrar em `business-rules.md` ou `finance.md`, o que for mais específico.
- **Decisão arquitetural tomada** (escolha entre duas abordagens, correção de um problema de design) → registrar em `decisions.md`.
- **Bug real encontrado que não será corrigido na mesma tarefa** → registrar em `known-bugs.md` com a correção esperada.

Nunca deixe a documentação desatualizada — um `known-bugs.md`/`database.md` errado é pior do que nenhum, porque induz a próxima tarefa a erro.

## Relação com o `CLAUDE.md` da raiz do repositório

O `CLAUDE.md` na raiz do projeto é carregado automaticamente pelo Claude Code em toda sessão e contém a visão rápida de orientação + este mesmo conjunto de regras de manutenção, em versão resumida. Esta pasta (`.claude/`) é a fonte completa e detalhada — o `CLAUDE.md` da raiz nunca deve duplicar o conteúdo técnico profundo que já está aqui, apenas apontar para cá.
