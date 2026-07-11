# Fluxo de Trabalho

> Escopo: o processo de raciocínio e os padrões de qualidade a seguir em **qualquer** tarefa de código neste repositório — antes, durante e depois de implementar. Não é sobre o que o sistema faz (isso está nos outros arquivos de `.claude/`), é sobre como abordar uma mudança nele. Vale tanto para tarefas pedidas pelo usuário quanto para melhorias encontradas no caminho (ver "Melhoria proativa" no final).

## Regra central: nunca escrever código imediatamente

Antes de tocar em qualquer arquivo, **explique por escrito**:

- **Problema** — o que exatamente está errado ou faltando, com base real no código (arquivo:linha), não em suposição.
- **Solução** — a abordagem proposta.
- **Vantagens** — por que essa abordagem, e não outra.
- **Riscos** — o que pode quebrar, degradar ou custar mais caro (performance, chamadas à API do ML, complexidade).
- **Impacto** — quais arquivos/tabelas/endpoints/páginas mudam, e o que fica sem alteração.

Só depois disso, implemente. Isso vale mesmo quando a tarefa parece pequena — o objetivo não é burocracia, é nunca editar código sem antes ter mapeado o que ele afeta neste sistema específico (EDA com dois processos, múltiplas lojas, rate limit da API do ML — ver `architecture.md`).

## Antes de qualquer alteração — checklist de análise

1. **Entenda o problema** — reproduza o comportamento atual, não confie só na descrição do pedido.
2. **Procure código semelhante** — use `Grep`/`Glob` antes de escrever algo novo; ver "Antes de criar" abaixo.
3. **Analise impacto** — quem mais lê/escreve o dado ou arquivo que você vai tocar (outra rota, o worker, outra página)?
4. **Analise performance** — a mudança adiciona uma query em loop, um `N+1`, uma chamada síncrona lenta numa rota HTTP?
5. **Analise segurança** — input não sanitizado indo para SQL (`api.js` já mistura interpolação de string com parâmetros em alguns pontos — ver nota abaixo), segredo exposto, endpoint sem validação.
6. **Analise banco** — a mudança precisa de migration? Ela vai para `database.md` e para a lista de `db/migrate.js` na mesma tarefa (ver `.claude/CLAUDE.md`, regra de manutenção)? Índice necessário para a nova query existe?
7. **Analise frontend** — a página segue o contrato de `frontend.md` (usa só `DB.*`, nunca `ML_API.*`/fetch direto)?
8. **Analise backend** — a rota respeita as regras de fronteira de `architecture.md` (leitura nunca chama `mlClient`, webhook responde 200 antes de processar)?
9. **Só depois implemente.**

> Nota de segurança já mapeada: vários endpoints em `routes/api.js` (ex. `store_id`/`level` em filtros) interpolam valores diretamente na string SQL em vez de usar `$N` parametrizado, mesmo em rotas que também usam parâmetros em outros trechos da mesma query. Ao tocar em qualquer uma dessas rotas, migrar o trecho tocado para parâmetro é esperado, não opcional — e o achado deve virar entrada em `known-bugs.md` se não for corrigido na mesma tarefa.

## Nunca aceitar

- Código duplicado — se a mesma lógica já existe em outro handler/rota, extrair e reusar, não copiar.
- Funções gigantes — um handler de webhook, uma rota REST, um sync agendado devem caber num propósito único (`workers.md`/`api.md` documentam o propósito de cada um; se um handler passar a fazer duas coisas, provavelmente deveria virar dois).
- Arquivos desnecessários — não criar um arquivo novo quando o conteúdo cabe (e faz sentido) num arquivo existente do mesmo domínio.
- Dependências desnecessárias — antes de `npm install`, checar se algo já em `server/package.json` resolve (ver `backend.md`).
- Lógica repetida — especialmente cálculo de margem (há uma única fórmula canônica, ver `finance.md` — não reimplementar variações dela).
- Consultas lentas — sem índice, sem `LIMIT`, sem filtro por `store_id`/data quando a tabela cresce (`orders`, `webhook_logs`, `item_changes`).
- Queries N+1 — iterar uma lista de linhas do banco disparando uma query por item em vez de um `JOIN`/`IN`/agregação (ver o padrão já usado em `produtos/performance`, `api.md`, como referência de agregação correta).
- Código sem tratamento de erro — toda chamada à API do ML pode retornar 429/401/5xx (ver `mercadolivre.md`); todo handler do worker precisa lidar com isso sem derrubar o processo.
- Código sem log — especialmente em handlers de webhook e syncs agendados, onde o único jeito de diagnosticar produção é `journalctl` (`deployment.md`).
- Código sem documentação — nesse projeto "documentação" significa o `.claude/*.md` correspondente atualizado, não necessariamente comentário inline (ver estilo de comentários no `CLAUDE.md` da raiz do Claude Code, seção de instruções gerais: comentário só quando o porquê não é óbvio).

## Antes de criar — procure se já existe algo semelhante

| Vai criar... | Procure primeiro em | Se de fato for novo, documente em |
|---|---|---|
| Arquivo | `Glob`/`Grep` na área correspondente | — |
| Função/módulo | arquivo do mesmo domínio (`worker.js`, `mlClient.js`, `routes/api.js`) | — |
| Endpoint REST | `api.md` (rota parecida já existe?) | `api.md` + método espelho em `js/db.js` |
| Migration/coluna/tabela | `database.md` (schema atual) | `database.md` + adicionar à lista de `db/migrate.js` |
| Handler de webhook / sync agendado | `workers.md` (tópico ou sync parecido?) | `workers.md` |
| Página/componente frontend | `frontend.md` (lista de páginas, `NAV_ITEMS`) | `frontend.md` + `js/layout.js` |
| Tópico WebSocket | `websocket.md` (catálogo de tópicos) | `websocket.md` |

## Revisão — perguntas antes de considerar pronto

- Posso simplificar?
- Posso reutilizar algo que já existe em vez de duplicar?
- Posso remover código (morto, comentado, redundante)?
- Posso reduzir o número de consultas (agregação em vez de loop, `JOIN` em vez de N+1)?
- Posso reduzir memória (não carregar mais linhas/colunas do que o necessário — atenção a `LIMIT` e a `SELECT *`)?
- Posso reduzir CPU (evitar recomputar o mesmo agregado em cada request quando cache/`cached()` resolveria — ver `redis.md`)?
- Posso reduzir o número de arquivos?

## Objetivos do projeto

- Dashboard em tempo real.
- Zero chamadas à API do Mercado Livre feitas pelo frontend.
- Escalar para milhares de pedidos/dia.
- Baixo consumo de API (rate limit do ML é o recurso mais escasso do sistema — ver `mercadolivre.md`).
- Alta disponibilidade.
- Arquitetura modular.
- Baixa manutenção.

## Prioridades, em ordem

1. **Performance**
2. **Escalabilidade**
3. **Simplicidade**
4. **Manutenção**
5. **Organização**
6. **Aparência**

Em caso de conflito entre duas abordagens, a prioridade mais alta da lista vence — ex.: uma solução mais simples de ler mas que gera uma query lenta em `orders` perde para uma solução com índice/agregação melhor, mesmo que menos "elegante".

## Melhoria proativa

Sempre que, durante qualquer tarefa, uma oportunidade de melhoria for encontrada — mesmo sem o usuário ter pedido:

1. **Pare.**
2. **Explique** o que foi encontrado (arquivo:linha, o problema real).
3. **Mostre os benefícios** concretos de corrigir agora.
4. **Pergunte** se o usuário deseja implementar — não implemente por conta própria fora do escopo pedido.

Achados que não forem implementados na hora devem virar entrada em `known-bugs.md` (se for defeito) ou `todo.md` (se for melhoria aceita mas adiada), para não se perder.
