# Bugs Conhecidos / Gaps

> Escopo: defeitos e inconsistências reais identificados no código atual — não é uma lista de features faltando (isso é `roadmap.md`/`todo.md`) nem de decisões deliberadas documentadas (isso é `decisions.md`). Cada item aqui deve apontar arquivo/linha e o sintoma esperado. **Ao corrigir um item, mova-o para `decisions.md` (se a correção envolveu uma escolha de design) e remova daqui.**

## 2. Tópico WebSocket `kpis_updated` documentado mas nunca publicado

`js/websocket.js` e o `CLAUDE.md` original citam `kpis_updated` como tópico emitido pelo backend, e `dashboard.js` está inscrito nele. Nenhum handler em `worker.js` publica esse tópico hoje — o dashboard na prática se atualiza via `order_updated`/`stock_alert` e um polling de 60s (`setInterval` em `dashboard.js`). Não é um bug funcional grave (o polling cobre a lacuna), mas é documentação/código morto — ver `websocket.md`.

## 3. `PATCH /api/custos/:sku` assume `sku === items.ml_id`

Documentado em `finance.md`: o endpoint grava o custo tanto em `sku_costs.cost` quanto em `items.cost WHERE ml_id = :sku`. Como `items` não tem coluna `sku` própria, isso só atualiza o item certo se o valor usado como "SKU" no frontend for, na prática, o `ml_id` do anúncio. Se o usuário informar um SKU interno diferente do `ml_id`, `sku_costs` é atualizado corretamente mas `items.cost` daquele produto **não** é.

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

## 11. Shopee polling retorna HTTP 403 — credenciais não configuradas em produção

`ShopeePollingEventSource.discoverEvents()` chama `client.listRecentOrders()` que faz uma requisição GET assinada `/api/v2/order/get_order_list`. A assinatura HMAC depende de `partner_id`, `partner_key` (credenciais da app) e `access_token`/`shop_id` (por loja). Quando `SHOPEE_PARTNER_ID` ou `SHOPEE_PARTNER_KEY` estão vazios em `server/.env`, a assinatura é calculada com strings vazias, causando HTTP 403 em todos os endpoints da Shopee.

**Síntoma**: logs mostram `[shopee-polling] (Shopee UNIFULL) listRecentOrders falhou: Shopee /api/v2/order/get_order_list -> HTTP 403` para qualquer chamada ao polling.

**Raiz**: `server/.env` em produção tem `SHOPEE_PARTNER_ID=` e `SHOPEE_PARTNER_KEY=` vazios, e `SHOPEE_ENV=sandbox` (deveria ser `production`). Conforme `.claude/shopee.md`, o app `financeecom` foi aprovado para produção com partner ID `2039090`; esses valores precisam ser configurados.

**Correção necessária** (ação do usuário, não código):
1. No servidor de produção, abrir `server/.env`
2. Configurar (valores do console Shopee Open Platform):
   - `SHOPEE_PARTNER_ID=2039090`
   - `SHOPEE_PARTNER_KEY=<chave live da API — nunca compartilhe>`
   - `SHOPEE_ENV=production`
   - `SHOPEE_REDIRECT_URI=https://multimixvendas.duckdns.org/auth/shopee/callback`
3. Salvar `.env` e reiniciar o servidor Node + worker
4. Verificar configuração acessando `https://multimixvendas.duckdns.org/auth/shopee/config` (diagnóstico)
5. Executar `node server/test-shopee-config.js` (script de diagnóstico local) pra confirmar

Depois que as credenciais forem configuradas, o polling retomará e sincronizará automaticamente os pedidos Shopee.

## 12. `items.ml_id` é PK simples — 2 lojas com o MESMO `item_id` colidiriam

`items` tem `PRIMARY KEY (ml_id)` porque `ml_id` é referenciado por FK em `item_seo_score` e `catalog_competition` (mudar a PK para composta exigiria tornar essas FKs compostas — refactor grande, adiado). A sincronização de catálogo Shopee usa `ON CONFLICT (ml_id, store_id)` (índice `items_ml_store_unique`, v45) para deduplicar por loja, mas se **duas lojas Shopee diferentes** tivessem o **mesmo `item_id`**, o `INSERT` da 2ª loja violaria `items_pkey (ml_id)` **antes** do `ON CONFLICT` agir — e o item da 2ª loja não entraria.

**Por que não é um problema real hoje**: o `item_id` da Shopee é único por listagem no nível da plataforma (cada anúncio recebe um id global distinto), então duas lojas nunca compartilham o mesmo `item_id`. IDs ML (`MLB…`) e Shopee (numérico) também nunca colidem. O caso só aparece em teste sintético forçando o mesmo id nas duas lojas.

**Correção esperada (se algum dia necessário)**: migrar `items` para `PRIMARY KEY (ml_id, store_id)` e converter as FKs de `item_seo_score`/`catalog_competition` para compostas, ou desacoplar essas tabelas de `items` via id surrogate.

## `js/db.js` `_post`/`_patch`/`_delete` engolem o erro do servidor em `null`

`_post` (e irmãos) fazem `catch { return null }`, então uma rota que responde 4xx/5xx
com `{error: "..."}` chega no frontend como `null` — a mensagem some. Páginas que
fazem `const res = await DB.xxx(); if (res?.error) toast(res.error); ... res.campo`
falham **caladas** (e ainda estouram `TypeError` ao ler `res.campo` de null), dando a
impressão de que "nada acontece". Corrigido pontualmente no botão Analisar da Análise
de Produtos (fetch direto pra ler a mensagem do servidor). **Correção definitiva
pendente**: `_post` retornar `{error}` em vez de `null` (ou relançar), e auditar as
páginas que dependem do retorno.

## ML bloqueia leitura de item de concorrente via API (403 access_denied)

`GET /items/{MLB}` de um anúncio que NÃO é do vendedor autenticado devolve
`403 access_denied` para este app (mesmo motivo do `/sites/MLB/search` — o app não
tem escopo de leitura pública ampla). Isso limita o monitoramento automático de
concorrentes (Análise de Produtos): o job diário e o botão "Puxar dados do ML"
funcionam só para itens acessíveis (próprios/catálogo). **Mitigação implementada**:
o `fetchItem` tenta o multiget (`/items?ids=`) como fallback, e o histórico de preço
do card é alimentado pela **extensão** (que lê a página renderizada e funciona) via
`monitor.recordSnapshot` a cada coleta. **Correção real** dependeria de escopo/app com
acesso público liberado pelo ML — fora do nosso controle.

## RESOLVIDO (v67) — coleta da extensão dava 500 "column descricao does not exist"

Sintoma: `POST /extension/anuncio` respondia 500 e nenhum concorrente era salvo. Log:
`[extension] POST anuncio column "descricao" of relation "analise_product_ads" does not exist`.
Causa: **drift de schema** — o banco de produção estava sem colunas que o `upsertAd`
(`analise/ads.js`) grava (descricao, highlights, comentarios_auto, vendas_*/preco_medio_*,
etc.), porque migrations históricas não foram aplicadas nessa instância. Correção: migration
**v67** reaplica TODAS as colunas de `analise_product_ads` com `ADD COLUMN IF NOT EXISTS`
(idempotente), alinhando com o `CREATE TABLE` de `schema.sql`. Lição: quando `upsertAd`/`mapAd`
ganham coluna nova, garantir a migration `ADD COLUMN IF NOT EXISTS` correspondente registrada
em `migrate.js` (ver a regra do CLAUDE.md sobre migrations).

## `migrate-v78.sql` é SQL inválido — nunca foi aplicada (nem em produção)

O arquivo foi escrito na **notação abreviada da documentação**, não em SQL real:

```sql
CREATE TABLE IF NOT EXISTS ranking_return_issues (
  id SERIAL PK,                                        -- PK não é SQL válido
  ranking_ad_id INT NOT NULL FK ranking_ads ON DELETE CASCADE,  -- FK idem
```

Confirmado rodando o schema completo num Postgres 16 limpo: `ERROR: syntax error at or near "PK"`. É o mesmo erro que aparece em produção a cada `npm run migrate`.

Consequência: como `db/migrate.js` manda o arquivo inteiro num único `pool.query` (um só batch, erro de parse rejeita tudo), **nada** da v78 foi aplicado — nem a tabela `ranking_return_issues`, nem a coluna `ranking_ads.nivel` (documentada em `database.md` como existente). Nada quebra na tela hoje porque o `nivel` mostrado no card é calculado em JS na rota (`1 + floor(sales_count/10)`) e a tabela `ranking_return_issues` não é usada por nenhum código; `devolucoes_count` está fixo em `0` na rota.

**Correção esperada:** reescrever a v78 em SQL válido e idempotente — `ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS nivel INT DEFAULT 1;` e, se a tabela de devoluções for mesmo necessária, `id SERIAL PRIMARY KEY` + `ranking_ad_id INT NOT NULL REFERENCES ranking_ads(id) ON DELETE CASCADE`. Se não for usada, remover a tabela do arquivo e da `database.md` em vez de criar schema morto. Enquanto não for feito, `database.md` está descrevendo uma coluna (`nivel`) e uma tabela que não existem no banco.

## `migrate-v77.sql` não é idempotente

`ALTER TABLE ranking_ads ADD COLUMN monitoramento_started_at ...` sem `IF NOT EXISTS` → toda reexecução loga `ERROR: column already exists`. Não causa dano (a coluna já está lá e `migrate.js` continua), mas polui o log de deploy e mascara erros reais. Correção: `ADD COLUMN IF NOT EXISTS`, como nas demais migrations.
