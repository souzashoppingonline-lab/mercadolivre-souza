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
