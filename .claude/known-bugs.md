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

## RESOLVIDO (v80) — `migrate-v78.sql` era SQL inválido e nunca foi aplicada

O arquivo foi escrito na **notação abreviada da documentação**, não em SQL real:

```sql
CREATE TABLE IF NOT EXISTS ranking_return_issues (
  id SERIAL PK,                                        -- PK não é SQL válido
  ranking_ad_id INT NOT NULL FK ranking_ads ON DELETE CASCADE,  -- FK idem
```

Confirmado rodando o schema completo num Postgres 16 limpo: `ERROR: syntax error at or near "PK"`. É o mesmo erro que aparece em produção a cada `npm run migrate`.

Consequência: como `db/migrate.js` manda o arquivo inteiro num único `pool.query` (um só batch, erro de parse rejeita tudo), **nada** da v78 foi aplicado — nem a tabela `ranking_return_issues`, nem a coluna `ranking_ads.nivel` (documentada em `database.md` como existente). Nada quebra na tela hoje porque o `nivel` mostrado no card é calculado em JS na rota (`1 + floor(sales_count/10)`) e a tabela `ranking_return_issues` não é usada por nenhum código; `devolucoes_count` está fixo em `0` na rota.

**Corrigido na v80:** o arquivo foi reescrito com `ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS nivel INT DEFAULT 1;`. A tabela `ranking_return_issues` foi **removida** do arquivo de propósito — nenhum código a usava, então criá-la seria schema morto (se um dia for necessária, entra em migration nova). Validado rodando `db/migrate.js` duas vezes contra um Postgres 16 limpo: 76 arquivos, 0 erros nas duas execuções, com a coluna `nivel` existindo ao final.

## RESOLVIDO (v80) — `migrate-v77.sql` não era idempotente

`ALTER TABLE ranking_ads ADD COLUMN monitoramento_started_at ...` sem `IF NOT EXISTS` → toda reexecução logava `ERROR: column already exists`, poluindo o log de deploy e mascarando erros reais. **Corrigido na v80** (`ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`), como nas demais migrations.

## Card de RANQUEADO mostra "Devoluções" sempre 0

`GET /api/ranking/ads` trazia `(SELECT COUNT(*) FROM returns ret WHERE ret.item_id = r.ml_id)`, mas `returns` **não tem** a coluna `item_id`: a rota inteira respondia 500 e todos os cards sumiam da tela. Corrigido trocando a subquery por `0 AS devolucoes_count` — a página voltou, mas o número é **decorativo**.

Para valer, precisa de um caminho real devolução → anúncio: `returns` guarda a reclamação/pedido, então o casamento teria de passar por `orders` (pedido → item → `ml_id`) ou por uma coluna nova preenchida no handler `post_purchase`. Enquanto isso não existir, não exibir número diferente de 0 nem prometer o dado na doc.

## `conta_empresas` — divergência de nomes de coluna entre a doc e o código

`financeiro-clone-guide.md` documenta a tabela como `conta_bancaria_id` + `empresa`. O código que roda em produção (`pages/financeiro-boletos.html`, filtro do modal de pagamento) lê `ce.conta_id` + `ce.empresa_nome`. Os dois não podem estar certos.

Como o ambiente de dev **não tem egress pro Supabase**, não dá pra confirmar qual é o real sem estar em produção. A gestão de contas do Fluxo de Caixa (v80) foi escrita **tolerante aos dois**: lê qualquer um dos nomes e, ao gravar, tenta primeiro o formato das linhas que já existem, caindo no outro se o PostgREST recusar.

**Correção esperada:** abrir `pages/financeiro.html` (explorador de tabelas) em produção, ver a prévia real de `conta_empresas`, corrigir o guia e então simplificar o código pra um formato só. Enquanto isso, o filtro de contas por empresa em Boletos pode estar silenciosamente vazio (ele cai pra "todas as contas" quando não casa nenhuma, então não quebra a tela — só não filtra).

## Trava de recebível duplicado é só na tela (sem índice único no Supabase)

A regra "uma empresa entra uma única vez por dia" em Recebíveis (v80) é validada no navegador, sobre as linhas que a página já carregou. Cobre o uso normal, mas **não** é garantia de banco: duas abas abertas ao mesmo tempo, ou uma inserção feita por fora da tela (outro cliente, o ERP no Readdy, importação), passam sem checagem.

**Correção esperada:** criar no Supabase um índice único `create unique index on receivables (empresa, date)` — o mesmo caminho de migration via MCP já usado para as colunas novas de `expenses`. Antes de aplicar, limpar as duplicatas que já existirem (o índice falha se houver). Com ele no ar, a tela passa a receber o erro do PostgREST como segunda barreira e a mensagem amigável continua sendo a primeira.

## Excluir usuário (ou trocar a senha) não derruba a sessão já aberta

O `staff_session` é um JWT stateless com validade de **180 dias**: `requireStaffAuth` só confere a assinatura, nunca consulta `staff_users`. Consequência: excluir o usuário, trocar a senha dele ou rebaixar o papel **não expulsa quem já está logado** — o cookie continua valendo até expirar. A tela de usuários avisa isso na confirmação de exclusão.

Hoje, cortar o acesso na hora exige trocar `STAFF_JWT_SECRET` no `.env` e reiniciar o `ml-dashboard-novo` — o que **desloga todo mundo**, inclusive o admin.

**Correção esperada:** coluna `sessions_valid_from TIMESTAMPTZ` (ou `token_version INT`) em `staff_users`, carimbada em toda troca de senha/papel/exclusão, e conferida no `requireStaffAuth` contra um snapshot em memória revalidado a cada ~30s (uma query por meio minuto no processo inteiro, não por requisição — o gate está no caminho crítico de toda página e toda API, então não pode virar um SELECT por request).

## Views `SELECT *` (`vw_ml_orders`/`vw_ml_items`/`vw_ml_stores`) ficam desatualizadas até o PRÓXIMO `npm run migrate`

Descoberto ao adicionar `orders.tarifa_manual` (v84) e confirmado com um Postgres real: uma view `CREATE VIEW v AS SELECT * FROM t` tem o conjunto de colunas **congelado no momento do CREATE** — uma `ALTER TABLE t ADD COLUMN` depois **não propaga** pra view, mesmo sendo `SELECT *` (comportamento documentado do Postgres, não bug do Postgres). `schema.sql` (que define as 3 views ML-only via `CREATE OR REPLACE VIEW ... SELECT * FROM orders/items/stores`, v17) é o **1º arquivo** da lista em `migrate.js` — roda ANTES de qualquer `migrate-vNN.sql` no mesmo `npm run migrate`. Consequência: uma migration que adiciona coluna em `orders`/`items`/`stores` E é consumida no mesmo deploy via `vw_ml_orders`/`vw_ml_items`/`vw_ml_stores` quebra com `column o.<coluna> does not exist` até o **próximo** `npm run migrate` rodar (quando `schema.sql` recria a view já vendo a coluna, adicionada numa execução anterior).

**Como a v84 evitou isso**: a própria `migrate-v84.sql` recria `vw_ml_orders` (`CREATE OR REPLACE VIEW`) depois do `ALTER TABLE`, garantindo que a view já sai atualizada na MESMA execução — não depende de rodar `migrate.js` 2x. Padrão a repetir em qualquer migration futura que adicione coluna em `orders`/`items`/`stores` e precise dela na mesma tarefa via uma das 3 views.

**Risco retroativo não investigado**: colunas adicionadas em `orders`/`items`/`stores` por migrations ANTERIORES à v84 (ex.: `finance_synced`/`finance_sync_attempts`/`last_finance_sync_at`/`last_finance_sync_error`, v82, já lidas via `o.finance_synced` em `vendaMargem.js`) podem ter ficado invisíveis pra `vw_ml_orders` por 1 ciclo de deploy até o `npm run migrate` seguinte rodar de novo — se em produção o deploy do v82 rodou `migrate.js` só 1x e não houve um 2º `npm run migrate` depois, e nada acusou erro, é porque provavelmente já rodou de novo em algum deploy seguinte (o sintoma seria `/vendas/detalhado` retornando 500 até lá). Não foi confirmado se isso realmente aconteceu — só fica registrado o mecanismo, caso apareça um erro parecido no futuro com uma coluna nova.

**Correção estrutural pendente** (não feita agora — escopo maior, mexe no fluxo de deploy): mover a criação das 3 views `SELECT *` pro FIM da lista de `files` em `migrate.js` (depois de todas as `migrate-vNN.sql`), ou adicionar uma etapa final que sempre recria as 3 views. Isso eliminaria a necessidade de cada migration nova lembrar de recriar a view manualmente.

## `MODULES.financeiro.pages` só lista uma página — as `financeiro-*.html` não estão gateadas pelo backend

`restrictedModuleForPath` (`staffAuth.js`) faz **match exato** contra `pages: [...]`, não por prefixo (`(m.pages || []).includes(p)`). `MODULES.financeiro.pages` tem só `['/pages/financeiro.html']` — mas o módulo cresceu para várias telas (`financeiro-compras.html`, `financeiro-pedidos.html`, `financeiro-boletos.html`, etc.) que **nunca foram adicionadas ao array**. Consequência: um papel não-`admin` não vê esses links no switcher (o gate de UI em `applyModuleAuth`/`js/layout.js` cobre isso), mas se souber/adivinhar a URL, o backend **não bloqueia** — a página carrega normalmente pra qualquer papel logado.

Ao criar `pages/bi-vendas.html` nesta tarefa, o caminho foi adicionado corretamente em `MODULES.bi.pages` — não repetir o gap do Financeiro em telas novas do BI.

**Correção esperada:** ou trocar `pages: [...]` por um prefixo (`financeiro`/`financeiro-*.html` batendo por `startsWith`), ou completar o array do Financeiro com todas as páginas `financeiro-*.html` existentes hoje. A 1ª opção evita esquecer de novo a cada tela nova.

## Correção de "frete do comprador vazando pra tarifa" não confirmada contra produção

`CONCILIACAO_TARIFA_LATERAL` (`vendaMargem.js`) exclui da tarifa uma linha "Payment" da Conciliação quando ela bate exatamente com `orders.shipping_cost` E há mais de 1 linha pro mesmo pedido — corrige o caso reportado pelo usuário (MLB7037761594, tarifa mostrando R$9,83 em vez de R$4,83 reais, diferença batendo exato com o frete do comprador de R$5,00). A lógica foi validada num Postgres 16 local com dados **sintéticos** reproduzindo o cenário hipotetizado (ver `business-rules.md`), não contra a linha real de `mp_account_movements` do pedido reportado — sem acesso ao Postgres de produção nesta tarefa.

**Mitigação já no ar**: `orders.tarifa_manual` (v84) — botão ✏️ em `bi-vendas.html` pra corrigir a tarifa na mão, pedido explícito do usuário como fallback pra esta mesma incerteza. Se a heurística automática não pegar um caso, a analista não fica bloqueada — edita direto, sem precisar de deploy novo.

**Se depois de subir a tarifa de algum pedido continuar errada** (a correção não pegou): a causa real pode não ser "2ª linha Payment com o valor do frete em MP_FEE_AMOUNT" — pode ser um formato diferente (ex.: o frete do comprador embutido na MESMA linha que a comissão, sem uma 2ª linha separada; ou uma diferença de sinal/arredondamento que quebra a comparação `ABS(mp_fee_amount) = shipping_cost`). Nesse caso, abrir Conciliação Bancária → Extrato, buscar o `order_id` problemático, e olhar as linhas cruas de `mp_account_movements` (`description='Payment'`) pra ver a forma real — só depois ajustar a heurística.

**Se, ao contrário, alguma comissão real passar a ser zerada por engano** (falso positivo): a proteção só dispara com `COUNT(*) > 1` — investigar se existe algum padrão legítimo de 2+ linhas Payment pro mesmo pedido onde uma bate por coincidência com o `shipping_cost` (ex.: reembolso parcial, ajuste manual) — nesse caso a condição (3) (linha sem `shipping_fee_amount` próprio) pode precisar ficar mais restritiva.

## Flag "imposto Flex" não cobre TODOS os cálculos de imposto do sistema

A fórmula `imposto = total_amount × stores.imposto_pct/100` está duplicada em vários lugares além de `calcularMargemLinha` (`vendaMargem.js`, único módulo que hoje respeita a flag `imposto_flex_ativo` — ver `business-rules.md`): `GET /api/vendas/hoje`, `GET /api/vendas/hoje-vs-ontem`, `GET /api/pedidos/:id/detalhes`, os relatórios de `server/src/reports.js` (resumo diário/semanal, Telegram) e `GET /api/vendas/margem` (tela "Margem por loja" em `vendas.html`/`lojas.html`) calculam imposto **direto em SQL própria**, sem passar por `vendaMargem.js`.

Consequência: com a flag desligada (padrão), uma venda Flex mostra imposto=R$0 em "Resumo por Venda"/Inteligência de Margem, mas continua mostrando imposto cheio nessas outras telas — dois números de lucro diferentes pra mesma venda, dependendo de qual tela você está olhando. Perguntado explicitamente ao usuário se deveria estender a flag pra lá também; resposta foi **não, só onde foi pedido** — então isso é um gap conhecido e aceito, não um bug esquecido.

**Correção esperada, se/quando o usuário pedir:** os mesmos 2 padrões já resolvidos em `vendaMargem.js`/`routes/api.js` (`GET /vendas/detalhado`) servem de referência — (1) função JS: aceitar `impostoFlexAtivo` e zerar quando `shipping_type==='self_service'`; (2) SQL agregada: trocar `total_amount * imposto_pct/100` por um `CASE WHEN shipping_type='self_service' THEN 0 ELSE ... END` quando a flag estiver desligada. Extrair a expressão SQL pra uma função auxiliar (`imposto_pct` já é column-based, não precisa de mais nada) evitaria repetir esse CASE em cada arquivo.
