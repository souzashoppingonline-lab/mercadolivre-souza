# Bugs Conhecidos / Gaps

> Escopo: defeitos e inconsistências reais identificados no código atual — não é uma lista de features faltando (isso é `roadmap.md`/`todo.md`) nem de decisões deliberadas documentadas (isso é `decisions.md`). Cada item aqui deve apontar arquivo/linha e o sintoma esperado. **Ao corrigir um item, mova-o para `decisions.md` (se a correção envolveu uma escolha de design) e remova daqui.**

## 1. `questions.tg_message_id` não existe em nenhuma migration

`server/src/worker.js` (`handleQuestion`) grava `tg_message_id` na tabela `questions` para permitir responder perguntas via reply no bot do Telegram (`routes/webhookGateway.js`, `POST /webhooks/telegram` consulta essa coluna). A escrita é protegida com `.catch(() => {})` ("column may not exist yet — ignore"), o que significa que **em qualquer banco criado só a partir das migrations versionadas** (`database.md`), essa coluna não existe e a funcionalidade de "responder via reply no Telegram" falha silenciosamente — o `UPDATE` nunca lança erro visível, só não persiste o `tg_message_id`, e o handler de reply em `webhookGateway.js` nunca encontra a pergunta correspondente.

**Correção esperada**: criar uma migration (`migrate-v15.sql` ou próxima) com `ALTER TABLE questions ADD COLUMN IF NOT EXISTS tg_message_id BIGINT;` e adicioná-la à lista em `db/migrate.js`.

## 2. Tópico WebSocket `kpis_updated` documentado mas nunca publicado

`js/websocket.js` e o `CLAUDE.md` original citam `kpis_updated` como tópico emitido pelo backend, e `dashboard.js` está inscrito nele. Nenhum handler em `worker.js` publica esse tópico hoje — o dashboard na prática se atualiza via `order_updated`/`stock_alert` e um polling de 60s (`setInterval` em `dashboard.js`). Não é um bug funcional grave (o polling cobre a lacuna), mas é documentação/código morto — ver `websocket.md`.

## 3. `PATCH /api/custos/:sku` assume `sku === items.ml_id`

Documentado em `finance.md`: o endpoint grava o custo tanto em `sku_costs.cost` quanto em `items.cost WHERE ml_id = :sku`. Como `items` não tem coluna `sku` própria, isso só atualiza o item certo se o valor usado como "SKU" no frontend for, na prática, o `ml_id` do anúncio. Se o usuário informar um SKU interno diferente do `ml_id`, `sku_costs` é atualizado corretamente mas `items.cost` daquele produto **não** é.

## 4. Migrations v5, v6, v7 e v10 fora da lista de `db/migrate.js`

`db/migrate.js` não inclui `migrate-v5.sql` (tabela `app_config`), `migrate-v6.sql` (tabela `promotions`), `migrate-v7.sql` (coluna `stores.imposto_pct`) nem `migrate-v10.sql` (índice único `messages.pack_id`) na lista de arquivos aplicados. O conteúdo de v5/v6/v7 já foi incorporado em `schema.sql`, então um banco novo fica correto — mas o índice único de `migrate-v10.sql` (`messages_pack_id_unique`) **não está** em `schema.sql` nem em nenhum arquivo da lista aplicada. Um banco criado do zero hoje via `migrate.js` **não tem** esse índice único, mesmo que o `ON CONFLICT (pack_id)` em `handleMessage` (`worker.js`) dependa dele para funcionar sem erro.

**Correção esperada**: adicionar `migrate-v10.sql` (ou equivalente) à lista em `db/migrate.js`, ou mover seu conteúdo para `schema.sql`.

## 5. `GET /api/vendas/diarias` usa margem estimada, não real

Não é bug de execução, mas risco de uso incorreto: essa rota retorna `liquido`/`taxas` calculados por uma constante fixa (88%/12% do bruto), diferente da fórmula real de margem usada em `vendas/detalhado` e `vendas/hoje` (`finance.md`). Se uma página nova passar a exibir esse `liquido` como "lucro real", vai divergir dos outros dashboards. Nenhuma página hoje expõe esse campo com destaque (é usado só internamente), mas fica registrado como armadilha para quem for construir algo novo em cima dele.

## 6. Cache `kpis:{storeId}` invalidado mas nunca escrito/lido

`handleOrder` (worker) chama `redis.del(\`kpis:${storeId}\`)` a cada pedido processado, mas nenhuma rota em `routes/api.js` usa essa chave (`cached('kpis:{storeId}', ...)`) hoje — só `kpis:summary` existe de fato. Código morto de invalidação, sem efeito prático, mas indica uma feature de "KPIs por loja com cache" que foi removida ou nunca terminada.

## 7. `var(--text-primary)` e `var(--text)` — variáveis CSS que não existem

Mesma classe de bug do `var(--card-bg)` (já corrigido em todo o projeto — ver `decisions.md`), mas para as variáveis de cor de texto. `css/style.css` só define `--text-main`/`--text-muted` no `:root`; `--text-primary` e `--text` nunca existiram. Como `color: var(--indefinida)` cai no valor herdado (geralmente já um texto claro, por herança do `body`), o efeito visual é bem mais discreto que o do `--card-bg` (que sumia o fundo inteiro) — por isso não foi corrigido junto, para não misturar um sweep silencioso com o que foi pedido/aprovado nesta tarefa.

**Arquivos afetados**: `var(--text-primary)` em `anuncios.html`, `vendas-por-loja.html`, `devolucoes.html`, `produtos.html`, `lojas.html`, `vendas.html`, `monitor.html`, `anuncios-problema.html`, `mcp.html`, `vendas-turbo.html`, `performance.html`, `schedule.html`, `css/style.css` (`.store-switcher-btn`), `js/dashboard.js` (gerado dinamicamente). `var(--text)` em `diasemana.html`, `reposicao.html`, `curvaABC.html`, `performance.html`, `schedule.html`.

**Correção esperada**: trocar ambos por `var(--text-main)` nesses arquivos, mesmo padrão da correção já aplicada para `--card-bg` → `--bg-card`.

## 8. `returns` não tem chave de dedup — "Importar histórico ML" duplica a cada execução

`INSERT INTO returns (...) ON CONFLICT DO NOTHING` (`worker.js`: `handlePostPurchase`, `syncReturns`) não tem nenhum `UNIQUE`/constraint alvo pra realmente conflitar — a claúsula `ON CONFLICT DO NOTHING` sem alvo só previne violação de constraint existente, e como não existe nenhuma em `returns`, toda chamada de "Importar histórico ML" (botão em `pages/devolucoes.html`) insere linhas novas por cima das já existentes em vez de atualizar, mesmo pra devoluções já importadas antes. O `claim.id` original do ML (que seria a chave natural de dedup) também não é persistido em nenhuma coluna hoje.

**Correção esperada**: adicionar coluna `claim_id BIGINT` em `returns` (migration nova), preenchida a partir de `claim.id` nos 3 pontos que já chamam `ml.getClaim()`, com `UNIQUE(store_id, claim_id)` e `ON CONFLICT (store_id, claim_id) DO UPDATE SET ...` (upsert de verdade, não `DO NOTHING`) — mesmo padrão já usado em `packing_videos`/`orders` pra idempotência.

## 9. Botão "▶ Executar" de `schedule.html` é no-op pra maioria dos jobs (nome kebab-case vs. camelCase)

`loadJobs()` renderiza um botão por linha de `schedule_jobs` chamando `triggerJob(j.name)` — `j.name` é o nome kebab-case gravado por `recordSync` (`sync-vendas`, `sync-visitas`, `sync-parent-items`, `cleanup-packing-videos`, `resumo-diario`, `email-diario`, `outlier-check`, `top-vendas`, etc.). Isso publica `{cmd: 'sync-vendas'}` em `worker:cmd`, mas o listener em `worker.js` só reconhece nomes camelCase de função (`if (cmd === 'syncVendas')` etc. — ver `workers.md`). Resultado: clicar em "▶ Executar" em qualquer linha da tabela de jobs **não dispara nada**, silenciosamente (o `catch {}` do listener engole até JSON inválido, então nem loga erro). Só os botões fixos "Sync Manual" no topo da página (`.sync-action-btn`, com `data-job` mapeado explicitamente pra nomes camelCase) funcionam de verdade. Descoberto ao adicionar o handler de `sync-seo-score` (registrado nos dois formatos, kebab e camelCase, justamente para não cair nessa armadilha).

**Correção esperada**: padronizar um dos dois lados — ou o listener passa a aceitar os nomes kebab-case de `schedule_jobs.name` (mais simples: 1 objeto de mapeamento kebab→função), ou `triggerJob` em `schedule.html` traduz `j.name` pro camelCase esperado antes de publicar (like o `apiName` que já existe só pros botões fixos, linha ~222). Não corrigido nesta tarefa por ser um bug pré-existente, fora do escopo da Qualidade de Anúncio.
