# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estilo de resposta — enxuto (economia de token)

Responda curto e direto. Sem recapitular o que já foi dito, sem repetir instruções de deploy em todo commit (diga uma vez), sem seções longas de "o que esperar". Só o essencial: o que foi feito + o passo que o usuário precisa dar. Leia da `.claude/` **só os arquivos da área que a tarefa toca** — não a pasta inteira em tarefas pequenas. O usuário pode pedir mais detalhe quando quiser.

## Convenção de branch

**O branch principal (padrão/default) deste repositório no GitHub é `claude/archive-files-git-8vn8pv`** — não existe `main` nem `master` neste repositório. Qualquer alteração que precise "estar no branch principal" deve ser mesclada/enviada para `claude/archive-files-git-8vn8pv`, não para um branch chamado `main`. Detalhes de fluxo de branches em `.claude/deployment.md`.

## Memória Permanente — pasta `.claude/`

Este projeto mantém documentação modular e viva em `.claude/` — um arquivo por assunto (arquitetura, backend, frontend, banco de dados, API, WebSocket, Redis, workers, integração Mercado Livre, Shopee, Amazon, regras de negócio, financeiro, deployment, roadmap, bugs conhecidos, decisões arquiteturais e todo). Índice completo com a lista de arquivos e o que cada um cobre: `.claude/CLAUDE.md`.

**Regras obrigatórias, sem exceção:**

1. **Leia toda a pasta `.claude/` antes de iniciar qualquer tarefa neste repositório** — antes de explorar o código-fonte, antes de propor uma mudança. Ela já documenta arquitetura, regras de negócio, decisões tomadas e bugs conhecidos; não redescubra o que já está escrito lá.
2. **A documentação é parte do projeto, tratada como código.** Toda tarefa que altera comportamento — nova rota REST, nova tabela/migration, novo handler de webhook/worker, novo tópico WebSocket, nova página frontend, nova regra de negócio, nova decisão arquitetural — deve terminar com o(s) arquivo(s) `.claude/*.md` correspondente(s) atualizado(s), **na mesma tarefa** em que o código muda. Nunca deixe a documentação desatualizada.
3. Registre decisões arquiteturais importantes em `.claude/decisions.md` e regras de negócio novas em `.claude/business-rules.md` (ou `.claude/finance.md` se for especificamente financeira) assim que forem descobertas ou definidas.

## Fluxo de trabalho obrigatório (resumo — detalhes em `.claude/workflow.md`)

**Nunca escreva código imediatamente.** Antes de qualquer alteração: entenda o problema, procure código semelhante, analise impacto/performance/segurança/banco/frontend/backend — e só depois implemente. Explique por escrito **problema, solução, vantagens, riscos e impacto** antes de programar. Nunca aceite código duplicado, funções gigantes, queries N+1/lentas, ou código sem tratamento de erro/log/documentação. Antes de criar arquivo/função/endpoint/migration/worker/página, procure se já existe algo semelhante (tabela de referência em `.claude/workflow.md`). Prioridades do projeto, em ordem: performance > escalabilidade > simplicidade > manutenção > organização > aparência. Ao encontrar uma melhoria não solicitada: pare, explique, mostre os benefícios e pergunte antes de implementar.

## Project Overview

Full-stack Mercado Livre seller dashboard using an **event-driven architecture (EDA)**. The frontend never calls the Mercado Livre API directly — all data flows through webhooks.

```
Mercado Livre → Webhook → Gateway → BullMQ → Worker
  → consulta só o recurso alterado → PostgreSQL → Redis → WebSocket → Dashboard
```

Detalhamento completo do fluxo e da topologia de processos: `.claude/architecture.md`.

## Backend Commands

```bash
cd server
cp .env.example .env      # preencher variáveis
npm install
npm run migrate           # cria/atualiza tabelas no PostgreSQL
npm start                 # inicia HTTP server (porta 3000 por padrão)
npm run worker            # inicia BullMQ worker (processo separado)
```

Variáveis de ambiente, dependências e configuração do processo HTTP: `.claude/backend.md`. Schema completo e migrations: `.claude/database.md`.

## Architectural Rules (resumo — detalhes em `.claude/architecture.md`)

1. **Nenhuma página HTML pode chamar a API do Mercado Livre diretamente.** Todo acesso a dados passa por `js/db.js` → `/api/*` → PostgreSQL/Redis.
2. **`js/api.js` não deve ser importado em páginas novas.** Existe só como referência histórica da API ML.
3. **`server/src/mlClient.js` só é chamado de dentro de `worker.js`** (ou de ações pontuais explícitas em rotas, nunca em leituras de listagem), nunca de rotas HTTP de leitura.
4. **O Webhook Gateway (`/webhooks/ml`) responde 200 imediatamente** e só depois processa. Nunca adicionar lógica síncrona lenta nessa rota.
5. **Invalidação de cache Redis:** sempre que um worker atualizar uma tabela, deletar a chave de cache correspondente (ex: `redis.del('kpis:summary')`). Detalhes de chaves em uso: `.claude/redis.md`.

## Onde encontrar o resto

| Preciso entender... | Leia |
|---|---|
| Estrutura de páginas/JS do frontend, como criar página nova | `.claude/frontend.md` |
| Todas as tabelas e colunas do Postgres | `.claude/database.md` |
| Todos os endpoints REST | `.claude/api.md` |
| Tópicos WebSocket emitidos/consumidos | `.claude/websocket.md` |
| Uso do Redis (cache, pub/sub) | `.claude/redis.md` |
| Filas BullMQ, handlers de webhook, jobs agendados, bot Telegram | `.claude/workers.md` |
| Agenda Trello (Kanban), TaskEngine, geração automática de cartões | `.claude/task-engine.md` |
| Embalagem (bipagem de etiqueta, vídeo de conferência) | `.claude/embalagem.md` |
| Login de acesso restrito (funcionários, papéis admin/embalagem) | `.claude/auth-staff.md` |
| OAuth, `mlClient.js`, rate limiting do Mercado Livre | `.claude/mercadolivre.md` |
| Status de integração Shopee/Amazon | `.claude/shopee.md`, `.claude/amazon.md` |
| Regras de negócio (thresholds, quando notificar, curva ABC...) | `.claude/business-rules.md` |
| Fórmulas de margem/ROI, planilha Vendas ML Turbo | `.claude/finance.md` |
| Produção (systemd, Postgres, nginx, lojas conectadas) | `.claude/deployment.md` |
| Direção futura do projeto | `.claude/roadmap.md` |
| Defeitos conhecidos ainda não corrigidos | `.claude/known-bugs.md` |
| Por que uma decisão de design foi tomada | `.claude/decisions.md` |
| Tarefas pendentes concretas | `.claude/todo.md` |

## Transição do Sistema Antigo

O serviço `ml-dashboard.service` (Node.js em `/src/server.js` do repositório `servidorlinux`) pode ainda estar rodando em produção como fonte de dados legada. Checklist de desativação e status atual: `.claude/roadmap.md` e `.claude/deployment.md`.
