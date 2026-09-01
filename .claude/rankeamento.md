# Rankeamento de Anúncios

> Escopo: acompanhamento intensivo de um anúncio na janela de ranqueamento do ML (anúncio novo). Registra CADA venda e CADA alteração, notificando tela (WebSocket) + Telegram, com marco a cada N vendas. Para o schema ver `database.md`; para os jobs/handlers ver `workers.md`; para os eventos WS ver `websocket.md`; para os endpoints ver `api.md`.

## Motivação

Anúncio novo no ML passa por uma janela crítica em que o algoritmo decide sua relevância/posição. Nesse período o vendedor quer ver **cada venda e cada mudança na hora** (tela + Telegram), não um resumo diário. A página **Rankeamento** (menu Operação) deixa marcar quais anúncios estão nessa fase e acompanhá-los venda a venda.

## Fluxo

```
webhook orders_v2 → handleOrder → ranking.onSale()  → ranking_events + WS 'ranking_event' + tg_rankeamento (+ marco a cada N)
webhook items     → handleItem  → ranking.onItemChange() → idem, para preço/estoque/status
job sync-ranking (6/6h) → ranking.snapshot() → visitas (API) + qualidade (item_seo_score) + buy-box (catalog_competition)
```

Núcleo em **`server/src/ranking.js`** (reaproveita `notify.js`/`ws/hub.js` — não duplica Telegram/WS). O worker só chama `onSale`/`onItemChange`/`snapshot` (hooks best-effort, nunca quebram o handler do ML). A página lê tudo via `/api/ranking/*`.

## O que é notificado (tela + Telegram, tópico `tg_rankeamento`)

| Evento | Origem | Quando |
|---|---|---|
| `venda` | `handleOrder` (tempo real) | cada venda de um anúncio em rankeamento (valor da linha, comprador, contador) |
| `marco` | após a venda | quando `sales_count % milestone_every == 0` (default 5): total, dias desde a 1ª venda, ritmo/dia, faturamento no período |
| `preco` | `handleItem` (tempo real) | preço mudou (de→para) |
| `estoque` | `handleItem` | estoque mudou; alerta extra se zerou (risco de pausar e perder rankeamento) |
| `status` | `handleItem` | status do anúncio mudou (active/paused/closed) |
| `visitas` | `snapshot` (6/6h) | visitas do último dia mudaram |
| `qualidade` | `snapshot` | `item_seo_score.score` mudou |
| `buybox` | `snapshot` | ganhou/perdeu o buy-box de catálogo (`catalog_competition.winner_item_id == ml_id`) |
| `esfriou` | `snapshot` fase 2 (v71) | sem vender há 3 dias (só ranqueado) |
| `destaque` | `snapshot` (v70) | entrou/saiu/mudou de posição nos **Mais Vendidos** da categoria (`mlClient.getCategoryHighlights` → `/highlights/MLB/category/:cat`); casa por item id (`type ITEM`) ou `catalog_product_id` (`type PRODUCT`); posição em `ranking_ads.last_highlight_pos` |

Preço/estoque/status vêm **de graça** do webhook de item (sem GET extra). Visitas/qualidade/buy-box não têm webhook → job periódico só dos anúncios ativos (poucos, limite `MAX_ADS=30`), sem varrer o catálogo, então não pesa no rate limit do ML.

## Anti-perda de venda (idempotência)

`onSale` roda para **todo pedido pago** de um anúncio monitorado (no `handleOrder`, fora do gate `isNewSale`/`!silent`), sem perder nem duplicar venda:

- **Idempotente por `order_id`**: antes de contar, checa se já existe evento `venda` com aquele `detail->>'order_id'` para o anúncio; se existe, retorna sem contar. Assim pode ser chamado à vontade em re-processos / sync / webhooks tardios.
- **Janela do anúncio**: só conta vendas com `saleDate >= ranking_ads.started_at` — uma re-sincronização do histórico não infla o contador com vendas anteriores à marcação.
- **Telegram só em tempo real**: o parâmetro `realtime` (= `isNewSale && !silent`) controla o alerta. Venda em tempo real na fase 1 → Telegram forçado; catch-up de sync, venda >24h ou fase 2 → conta **em silêncio** (só tela), sem spam. O marco (`milestone`) recebe o mesmo `realtime`.

Isso corrige o gap em que vendas processadas em `silent` (importação/sync) ou sem transição real de status não entravam no rankeamento.

## Vínculo tradicional ↔ catálogo (v75)

No ML o mesmo produto pode ter **dois anúncios** com `ml_id` diferentes: o **tradicional** e o de **catálogo**. Como `onSale` casa a venda pelo `ml_id`, marcar só um deixava as vendas do outro "sem card". Solução: um card pode **vincular** outros `ml_id` (tabela `ranking_ad_links`, ver `database.md`).

- **Contagem de venda** usa `getTracked(mlId, includeLinks=true)` — resolve a venda pelo `ml_id` principal **ou** por qualquer vinculado → conta tudo no mesmo card (idempotência por `order_id` + `ranking_ad_id` continua valendo).
- **Preço/estoque/status/snapshot** usam `getTracked(mlId)` **sem** links (só o anúncio principal) — o card não fica alternando preço entre os dois anúncios; o catálogo só soma **vendas**.
- **UI**: botão 🔗 no card abre um modal de busca (`buscarRankingItems`) pra escolher o anúncio a vincular (`POST /ads/:id/links`, `DB.vincularRankingAd`). Os vínculos aparecem como chips no card (com X pra desvincular → `DELETE /ads/:id/links/:linkId`). Sem auto-detecção: `catalog_product_id` (em `catalog_competition`) agrupa o mercado inteiro do produto, não só os anúncios da própria loja, então o vínculo é **manual**.

## Semente anti-alerta-falso

Ao marcar um anúncio (`POST /ads`), os `last_price`/`last_available_quantity`/`last_status` são semeados a partir de `items`, e `base_price` guarda o preço de referência. Assim a 1ª alteração real dispara evento (não a leitura inicial). `onItemChange` também atualiza os `last_*` mesmo sem evento, para semear anúncios recém-marcados.

## Regras / limites

- **Marco a cada N vendas**: `milestone_every` por anúncio (default 5, editável no `POST`/`PATCH`).
- **Duração**: fica ativo até o usuário **remover** (DELETE, apaga histórico via CASCADE) ou **pausar** (`active=false`, mantém histórico, para de notificar). Não auto-desliga.
- **Limite**: `MAX_ADS=30` anúncios ativos (o snapshot roda por anúncio ativo — trava de proteção).
- **Silêncio/throttle do Telegram**: eventos `venda` e `marco` usam `tgNotifyForce` (ignoram silêncio/throttle) — a mensagem "Venda de produto em rankeamento" **sempre** sai logo depois do alerta de venda normal (`tg_vendas`). Os demais eventos (`preco`/`estoque`/`status`/`visitas`/`qualidade`/`buybox`/`destaque`) usam `tgNotify` (respeitam silêncio/intervalo). Ativar/desativar o tópico: chave `tg_rankeamento` em `app_config` — só afeta os eventos não-forçados (venda/marco ignoram, por serem o núcleo da feature).

## Duas fases (v71): rankeando → ranqueado

Cada anúncio tem `ranking_ads.fase`:

| | **rankeando** (empurrar) | **ranqueado** (defender) |
|---|---|---|
| Cada venda | 🔔 tela + Telegram forçado ("Venda de produto em rankeamento") + marco | conta em silêncio (só tela), **sem** Telegram |
| Snapshot | qualquer mudança (subiu/caiu), a cada 6h (`sync-ranking`) | **só regressão**, 1x/dia (`sync-ranking-ranqueado`, 05:15) |
| Regressão vigiada | — | perdeu buy-box, saiu/caiu nos Mais Vendidos, visitas **−40%+**, qualidade piorou, estoque, **esfriou** (sem vender há 3 dias) |

**Transição manual** (`PATCH /api/ranking/ads/:id {fase}`): botão "Marcar como ranqueado" / "Voltar pra ranqueamento". Passar pra `ranqueado` carimba `ranqueado_em`; voltar limpa. A rota `/ads` devolve `sugerir_ranqueado` (bool) — sugere quando bate qualquer critério objetivo (entrou nos Mais Vendidos **ou** ganhou buy-box **ou** ≥ 10 vendas **ou** ≥ 15 dias); quem confirma é o usuário (nunca automático). Novo evento `esfriou` 💤.

**Níveis de progressão (v78):** anúncio em **RANQUEADO** exibe seu **Nível** (1 + floor(sales_count / 10)) — a cada 10 vendas acumuladas, sobe de nível (Nível 1, Nível 2, Nível 3…). Também mostra **Devoluções** — só visível em RANQUEADO, colorida em verde (nenhuma) ou vermelho. ⚠️ **Hoje é sempre 0**: a query original lia `returns.item_id`, coluna que não existe (quebrava a rota inteira com 500), então o campo ficou fixo em `0 AS devolucoes_count` até existir uma forma real de casar devolução ↔ anúncio. Ver `known-bugs.md`.

A página tem 6 abas: **Em rankeamento**, **Ranqueados**, **Monitoramento**, **Recuperação** (v80, ver abaixo), **Catálogo (Buy Box)** (v88, ver abaixo — arquitetura diferente das outras 4: sem `MAX_ADS`, sem venda-a-venda, só status de concorrência) e **Todos os anúncios** (tabela de seleção).

## Três estágios + mudança manual (v76) — quatro a partir da v80

Além de `rankeando` e `ranqueado`, existe o 3º estágio **`monitoramento`**: um produto que **já ranqueou mas caiu**, no qual foram feitas alterações e agora se acompanha o efeito. A transição entre os 3 é **manual**, por um **seletor de estágio** (`<select>`) no card (`mudarFase` → `PATCH /ads/:id {fase}`). Regras do carimbo: `→ranqueado` seta `ranqueado_em=now()`, `→rankeando` limpa, `→monitoramento` seta `monitoramento_started_at=now()` (v77 — rastreia quando entrou em monitoramento). **Contador de dias (v80):** cada fase conta a partir do **seu** marco de entrada, não do `started_at` — "Xd em rankeamento" (`started_at`), "**Xd ranqueado**" (`ranqueado_em`, badge verde ✅ — antes o card mostrava dois badges, "Xd em rankeamento" + a data de ranqueamento), "Xd em monitoramento" (`monitoramento_started_at`), "Xd em recuperação" (`recuperacao_started_at`). Card antigo sem o carimbo da fase mostra só o rótulo, sem número (não inventa dias a partir do `started_at`). A partir da v80 `monitoramento` também é varrida pelo snapshot de 6h (antes nenhum job a varria, e o card ficava com visitas/qualidade vazias para sempre). Layout de `monitoramento` = modo saúde (igual ranqueado) + um **banner âmbar** e o log de alterações. Cores dos badges: rankeando amarelo, ranqueado verde, monitoramento âmbar (#f59e0b).

**Log de alterações (`ranking_notes`):** cada card tem um botão **📋 Alterações** (ícone `clipboard-list`, com contador `notas_count`) que abre um modal para **escrever e ler** anotações livres do que foi mudado (baixei preço, troquei foto, ajustei título…), cada uma com data. Rotas `/ads/:id/notas` (GET/POST/DELETE), métodos `DB.getRankingNotas`/`addRankingNota`/`delRankingNota`. Disponível em qualquer fase, mas é o centro do estágio Monitoramento. As vendas em `monitoramento` contam em silêncio (como ranqueado).

## Multi-canal (ML + Shopee)

Anúncios e pedidos das duas plataformas vivem nas mesmas tabelas `items`/`orders` (discriminados por `marketplace_id`), então o rankeamento serve os dois. A página tem um filtro **Todos os canais / Mercado Livre / Shopee** (`?marketplace=` em `/ranking/ads` e `/ranking/buscar`) e um selo de canal em cada card/linha.

- **Vendas Shopee**: `handleShopeeOrderEvent` (`marketplaceEventWorker.js`) chama `ranking.onSale` por item do `item_list` (mesma guarda anti-pedido-antigo de 24h). Venda + contador 5-em-5 + marco funcionam igual ao ML.
- **Faturamento do marco**: somado dos próprios `ranking_events` (campo `detail.valor`), não de `orders.item_id` — a Shopee não popula `item_id` em `orders`, então essa era a única forma agnóstica.
- **Limitações Shopee (hoje)**: o snapshot `sync-ranking` (visitas/qualidade/buy-box/destaque) roda **só para anúncios ML** (usa a API do ML); e preço/estoque/status **não** notificam para Shopee (o hook `onItemChange` está só no `handleItem` do pipeline ML). Shopee recebe venda/marco em tempo real; o resto é gap conhecido.

## Avisos de Revisão de ADS (v79)

Um card pode agendar **múltiplos avisos** via Telegram para revisar os ADS — agenda uma data/hora, opcionalmente com observação. Tabela `ranking_ads_alerts` grava os avisos agendados. Job `syncRankingAlerts` (1x/h no worker) verifica avisos que chegaram à hora, dispara via Telegram (forçado, independente de silêncio) e marca `notified_at` — a mensagem leva título, MLB, loja, data agendada, a observação e o link do anúncio. Dá pra forçar sem esperar a hora cheia com `redis-cli PUBLISH worker:cmd '{"cmd":"sync-ranking-alerts"}'`. (Três defeitos que impediam o disparo foram corrigidos na v80 — ver `workers.md`.) Modal na página com datetime-picker e formulário de observação; lista os avisos agendados (com status ✅/⏰). Rotas: `GET /api/ranking/ads/:id/alerts` (listar), `POST /api/ranking/ads/:id/alerts` (agendar).

## Visitas / qualidade / buy-box: snapshot com fallback (v80)

Os campos `last_visits`/`last_seo_score`/`last_buybox` só são preenchidos pelo **snapshot da fase** — então card recém-movido, ou de fase não varrida por job, mostrava `—` indefinidamente (era o caso do **Monitoramento**, que nenhum job varria). Duas correções:

1. **Origem:** `sync-ranking` (6/6h) agora varre `rankeando` + `recuperacao` + `monitoramento` na mesma execução (uma só rajada de chamadas ao ML). `ranqueado` segue no job diário das 05:15.
2. **Fallback na leitura** (`GET /ads`): quando o `last_*` está vazio, a rota cai para o que já existe no banco, sem chamar o ML — visitas = média de 7 dias de `item_visits`, qualidade = `item_seo_score.score`, buy-box = `catalog_competition.winner_item_id == ml_id`. O snapshot continua tendo prioridade quando existe. Campos devolvidos: `visitas_dia`, `qualidade`, `buybox` (o card usa esses, não os `last_*` crus). Posição nos Mais Vendidos não tem fallback — só vem do snapshot.

## 4º estágio: Recuperação (v80) — anúncio que NÃO vende

`fase = 'recuperacao'` (badge 🩺 vermelho `#f85149`, aba própria). Enquanto `monitoramento` é "já ranqueou e caiu", **recuperação é "nunca decolou / parou de vender"**: o trabalho aqui é intervir (ADS, título, palavras-chave, fotos, preço) e medir se destravou. A escala das abas vira: *rankeando* (empurrar) → *ranqueado* (defender) → *monitoramento* (caiu, observando) → *recuperação* (parado, intervindo).

Carimbo `recuperacao_started_at` na entrada (mesmo padrão da v77); o contador do card lê "Xd em recuperação". **Nenhuma transição é automática** e **nada é excluído sozinho**, por mais tempo que o anúncio fique parado — igual às outras fases.

**O que o card mostra (tudo derivado de dado que já tínhamos, sem nova integração):**

| Bloco | Fonte |
|---|---|
| `Xd sem vender` + semáforo 🟡 0–7 / 🟠 8–14 / 🔴 15+ | `last_sale_at` (ou `started_at` se nunca vendeu) → `dias_sem_venda`/`semaforo`/`nunca_vendeu` |
| **Diagnóstico** (exposição × conversão) | `last_visits` × `item_seo_score.conversion_rate` → campo `diagnostico` (thresholds em `business-rules.md`) |
| Visitas/dia · Conversão 30d · Vendas **na fase** · Qualidade · Estoque · Preço (+ `price_to_win`) | `last_visits`/`item_visits` (média 7d), `item_seo_score`, `ranking_events` desde `recuperacao_started_at`, `catalog_competition` |
| **Checklist "o que dá pra melhorar"** | `item_seo_score`: `pictures_count`, `has_video`, `title_length`, `description_word_count`, `missing_required_attrs`, `is_full`. Ordena ❌ → ⚠️ → ✅ |
| **Intervenções** com efeito medido | `ranking_notes` tipadas (abaixo) |
| Rodapé: ✅ Recuperou · ⏹ Encerrar · 🔔 Reavaliar em… | `PATCH {fase:'rankeando'}` / `PATCH {active:false}` + nota de fecho / modal de aviso (v79) |

O bloco de campanha de ADS (nome/ROAS/orçamento/preço) aparece nesta fase também — é justamente onde se mexe em ADS.

**Intervenções medidas (`ranking_notes.tipo` + `baseline`):** ao registrar uma alteração escolhendo um **tipo** (`titulo`, `keywords`, `fotos`, `descricao`, `preco`, `ads`, `atributos`, `frete`, `outro`), o backend **carimba um baseline** (`{visitas, conversao, score, vendas, preco, at}`). O **efeito é calculado na leitura** (atual − baseline), sem job e sempre fresco:

| Veredito | Regra |
|---|---|
| ⏳ `medindo` | menos de 7 dias desde o registro (mostra quantos faltam) |
| ✅ `funcionou` | houve venda depois da alteração |
| 🔵 `parcial` | visitas +20% ou mais, ainda sem venda (tráfego melhorou, oferta não converte) |
| 🔻 `piorou` | visitas −20% ou mais |
| ⚠️ `sem_efeito` | nem tráfego nem venda |

Nota **sem tipo** continua sendo anotação livre (não carimba baseline) — o log da v76 segue funcionando igual nas outras fases.

**Telegram nesta fase:** a **1ª venda depois de entrar** sai com mensagem própria ("🎉 DESTRAVOU!", com quantos dias ficou parado e sugestão de voltar pra rankeando — evento `venda` com `detail.recuperou`); ao bater **15 dias parado** sai 1 alerta `sem_resultado` 🔴 ("Hora de decidir", com a contagem de intervenções), idempotente por entrada na fase (mesmo padrão do `esfriou`). Visitas/qualidade/preço seguem a regra da fase 1 (qualquer mudança).

**Snapshot:** roda junto com `sync-ranking` (6/6h, mesma rajada de chamadas ao ML) — quem está em intervenção precisa de visitas frescas pra medir efeito. Conta no mesmo teto `MAX_ADS=30`.

> Ainda **não** implementado: alerta no Telegram quando uma intervenção fecha a janela de 7 dias sem efeito (hoje isso só aparece no card). Ver `todo.md`.

## 5º estágio: Catálogo / Buy Box (v88) — anúncio de catálogo, sem limite de 30

`fase = 'catalogo'` (badge roxo `#a855f7`, ícone 🏆, aba própria). Diferente dos outros 4 (que empurram/defendem/monitoram/recuperam UM anúncio de cada vez), este é um estágio de **alocação em massa**: o usuário aloca **todos os anúncios de catálogo** que quiser acompanhar — o card mostra só o status de concorrência (ganhando/perdendo/compartilhando o 1º lugar), não venda-a-venda. Reusa 100% a infraestrutura de Buy-Box que já existia (`catalog_competition`/`catalog_competition_history`, v26, ver `business-rules.md` "Monitor de Buy-Box") — não duplica schema nem fórmula, só passa a EXPOR isso como um estágio do Rankeamento (antes só aparecia dentro do módulo Qualidade de Anúncio e como 2 campos no card de Recuperação).

**Sem o teto de `MAX_ADS=30`:** essa trava existe porque o snapshot de rankeando/ranqueado/monitoramento/recuperação (`sync-ranking`, 6/6h) chama a API por anúncio ativo — 'catalogo' **não** entra nesse snapshot (usa o job `sync-catalog-competition` dedicado, com throttling próprio, ver abaixo), então o motivo original da trava não se aplica. `POST /api/ranking/ads` conta só `WHERE active=true AND fase != 'catalogo'` pro teto — dá pra alocar quantos anúncios de catálogo quiser sem esbarrar no limite pensado pro punhado sendo empurrado manualmente.

**Alocação:** dois caminhos, os dois carimbam `catalogo_started_at` e disparam uma busca `price_to_win` **na hora** (sob demanda, best-effort — nunca derruba a resposta se falhar):
1. Direto — na aba "Todos os anúncios", o botão "Acompanhar" da linha virou um `<select class="rk-add-sel">` ("Acompanhar em..." + os 5 estágios); escolher uma opção já dispara o `addAd(mlId, fase, this)` com aquele estágio (v88.1 — substituiu o seletor global "Adicionar em:" que ficava no topo da busca, porque ele valia pra todos os cliques seguintes e era fácil esquecer trocado; agora a escolha é por linha, sem estado compartilhado). Fica na mesma aba depois de adicionar (não troca de painel) — é o que permite alocar VÁRIOS anúncios seguidos, cada um pro estágio que quiser, sem perder a busca. `POST /ads {ml_id, fase:'catalogo'}`.
2. De qualquer outro estágio — seletor de estágio no card, escolhendo "Catálogo (Buy Box)". `PATCH /ads/:id {fase:'catalogo'}`.

**Sincronização "aos poucos", sem rate limit (pedido explícito do usuário):** o job diário `sync-catalog-competition` (04:50, `worker.js`) — que já tinha throttling pesado (10s entre itens, pausa de 30s a cada 10, 60s+circuit-breaker em 429; nada mudou aí) — teve sua **seleção de itens estendida**: além de `item_seo_score.catalog_listing=true` (como já era), agora também cobre `ranking_ads` com `fase='catalogo' AND active=true` (UNION deduplicado por item_id). **Itens NUNCA sincronizados vêm primeiro na fila** (`ORDER BY calculated_at ASC NULLS FIRST`) — quem acabou de ser alocado é priorizado sobre quem já tem dado, mesmo que o catálogo inteiro não caiba numa execução só. A busca sob demanda do momento da alocação (acima) cobre a urgência de "ver algo agora"; o job cobre o resto gradualmente, dia a dia, sem gastar rate limit numa rajada.

**O que o card mostra** (tudo já vem no payload de `GET /ads`, via o `LEFT JOIN catalog_competition` que já existia pra Recuperação — só mais colunas expostas, nenhum JOIN novo):

| Bloco | Fonte |
|---|---|
| Status: 🏆 GANHANDO / 📉 PERDENDO / 🤝 COMPARTILHANDO O 1º LUGAR / ⏳ Aguardando 1ª sincronização | `winner_item_id === ml_id` → ganhando (nunca a string crua de status — só `'competing'` foi confirmado ao vivo, ver `business-rules.md`); `buybox_status === 'sharing_first_place'` é a ÚNICA outra string tratada com confiança, porque veio documentada explicitamente pelo usuário nesta tarefa (as 4 strings oficiais: `winning`/`competing`/`sharing_first_place`/`listed`) |
| Seu preço / Preço pra vencer / Diferença | `preco_atual` (de `items`) × `price_to_win` |
| Vencedor ("Você" ou o `ml_id` do concorrente) / Preço do vencedor | `winner_item_id` / `winner_price` |
| "Por que pode estar perdendo" (chips) | `boosts_missing[]` traduzido (`fulfillment`→Full, `free_shipping`→Frete grátis, `same_day_shipping`→Entrega no mesmo dia, `official_store`→Loja oficial, `discount`→Desconto ativo, `loyalty_discount`→Desconto por fidelidade, `free_installments`→Parcelamento sem juros — id desconhecido, ex. `shipping_collect`, cai no texto cru, nunca inventa tradução). Cada chip tem `title` com uma frase explicando o motivo no hover; id desconhecido mostra um aviso honesto de que a explicação não está confirmada em vez de chutar |
| Estoque | `available_quantity` (já vinha) |
| "Sincronizado em…" | `catalog_competition.calculated_at` |
| Botão **"Ver concorrentes"** | Reusa 100% a rota já existente `GET /api/qualidade-anuncio/:itemId/concorrentes` (`ml.getCatalogCompetitors`, sob demanda) — mesmo componente do módulo Qualidade de Anúncio, nenhuma rota nova. Modal lista cada vendedor (preço/Full/frete grátis/quem é o vencedor), marca "(você)" na sua linha. |

**Ciclo de campanha completo (v88.2, pedido do usuário):** o card do Catálogo também ganhou o mesmo bloco de "Em rankeamento" — badge `🔄 Ciclo N` no cabeçalho, bloco de campanha (`adsBlock`: nome/ROAS/orçamento/preço + "Lançar no histórico"), botão **"Novo ciclo"** e `ciclosBlock` (histórico de ciclos encerrados). Nenhuma rota nova: `PATCH /ads/:id` e `POST/GET /ads/:id/ciclo(s)` já eram genéricos (nunca checavam `fase`), só as condicionais do frontend (`rankeando ? ... : ''`) foram estendidas pra `(rankeando || catalogo)`. **O que É novo:** o avanço automático de ciclo a cada `milestone_every` vendas (`ranking.js`, `milestone()`) só rodava em `fase === 'rankeando'` — estendido pra também rodar em `'catalogo'`, já que agora esse estágio também acompanha campanha por ciclo.

**Botão "Ver vendas" (v88.2):** no rodapé do card, ao lado de "Ver concorrentes" — abre um modal com o total de vendas dos últimos 15 e 30 dias + a série dia a dia (mini barra + quantidade + faturamento por dia), via `GET /ads/:id/vendas-periodo` (ver `api.md`). Funciona pra qualquer anúncio rankeado (não é exclusivo do Catálogo), mas só tem botão visível ali — foi o estágio onde "como estão indo as vendas" não tinha nenhuma resposta na tela (os outros 4 já mostram `sales_count`/faturamento acumulado direto no card).

**Histórico em tempo real (v88) — webhook `catalog_item_competition_status`:** além do job diário e da busca sob demanda na alocação, `worker.js` agora tem um handler pra esse tópico (`ranking.onCatalogCompetitionUpdate`) que atualiza `catalog_competition`/`catalog_competition_history` **na hora** que o Mercado Livre avisa uma mudança de status, e — se o item estiver tracked em QUALQUER estágio do Rankeamento — emite o mesmo evento `buybox` (🥇 ganhou / ⚠️ perdeu) que o snapshot periódico já emitia pras outras fases, com a MESMA mensagem/formato (`ranking.emit()`, nunca uma 2ª fórmula), evitando duplicar notificação via `ranking_ads.last_buybox`.

> ⚠️ **Depende de configuração fora deste código**: o tópico `catalog_item_competition_status` precisa estar **habilitado no painel de desenvolvedor do Mercado Livre** pra este app. Se não estiver, o ML nunca manda o webhook e o handler nunca roda — **sem qualquer regressão**: o job diário `sync-catalog-competition` continua sendo a fonte normal, exatamente como já era antes desta tarefa. O formato exato do `resource` desse tópico também não foi confirmado ao vivo (a extração do `item_id` tenta achar um `MLB\d+` em qualquer posição do path, com fallback pro último segmento — mesma defesa já usada em `handleOffer`). Ver `mercadolivre.md`/`decisions.md`.

## Página `pages/rankeamento.html`

Duas partes: (1) **cards dos anúncios em rankeamento** no topo — badge "Anúncio em rankeamento", contador com barra de progresso 5-em-5, stats (faturamento/visitas/estoque/preço) e **timeline venda-a-venda ao vivo** (WS `ranking_event` insere no topo na hora); botões pausar/remover + **🔔 Aviso ADS** (agendar lembrete). (2) **tabela com todos os anúncios** (busca por título/MLB) com um `<select>` por linha ("Acompanhar em...", v88.1) que promove o anúncio a card já no estágio escolhido — inclusive Catálogo (Buy Box), sem passar por 'rankeando' primeiro. Métodos em `js/db.js`: `getRankingAds`, `buscarRankingItems`, `addRankingAd` (aceita `fase` opcional, v88), `patchRankingAd`, `removeRankingAd`, `getRankingEventos`, `getRankingAlerts`, `agendarRankingAlert`, `getQualidadeAnuncioConcorrentes` (reusado no modal "Ver concorrentes" do estágio Catálogo).

**Ordenação por vendas na aba "Em rankeamento" (v88):** select "Ordenar por" (Padrão/Mais vendidos/Menos vendidos) só nessa aba — client-side, sobre `sales_count` (cumulativo através dos ciclos, mesmo número do contador do card), sem request nova (`ordenarPorVendas()` reordena a lista já carregada antes de `renderPanel`). As outras abas (Ranqueados/Monitoramento/Recuperação/Todos) não têm esse seletor.

**Filtro por empresa/loja (ML):** select global `rkLoja` (topo, ao lado das abas) populado por `GET /api/lojas` (`DB.getLojas`) — filtra os cards (rankeando/ranqueado) **e** a tabela por `store_id`. As rotas `GET /api/ranking/ads?...&store_id` e `GET /api/ranking/buscar?...&store_id` aceitam o filtro (`r.store_id`/`i.store_id`). Cada card já mostra a loja (`store_nickname`).

## Ciclos de rankeamento + métricas de ADS (v72/v73)

Um anúncio **em rankeamento** passa por **ciclos** (campanhas/empurrões sucessivos). O card mostra o **Ciclo N** atual (badge 🔄 azul, em destaque no topo) e campos **preenchidos manualmente** — **nome da campanha** (texto), ROAS, orçamento diário (R$) e a transição de preço (**preço anterior → preço atual**) — porque o ML não expõe esses dados por webhook. Colunas em `ranking_ads`: `ciclo`, `campanha_nome`, `roas`, `orcamento_diario`, `preco_anterior`, `preco_atual`, `ciclo_iniciado_em` (ver `database.md`). `ads_investido` (v72) ficou legado — saiu do card, substituído pelo nome da campanha (v74).

- **Vendas são cumulativas:** o contador (5-em-5), `sales_count` e o `faturamento` **contam através dos ciclos** — trocar de ciclo **não zera** nada. O ciclo é só um rótulo de fase de campanha.
- **Salvar manual:** cada input salva no `onchange` via `PATCH /api/ranking/ads/:id` (`DB.patchRankingAd`) — sem re-render, pra não perder o foco. Dicas no card: **ROAS calculado** (faturamento ÷ ADS) e a seta de preço (↑/↓/=); os campos continuam manuais (fonte de verdade).
- **Troca AUTOMÁTICA a cada N vendas (v82):** na fase `rankeando`, ao bater um múltiplo de `milestone_every` (padrão 5) o ciclo **vira sozinho** — 5 vendas → Ciclo 2, 10 → Ciclo 3, 15 → Ciclo 4, e assim por diante. Roda dentro de `milestone()` (`server/src/ranking.js`), chamando a mesma `avancarCiclo(adId)` do botão manual. Gera um evento `ciclo` (silencioso, só tela/WS) com `{de, para, sales_count, automatico:true}`, e a mensagem de marco no Telegram passa a dizer "Ciclo N encerrado — agora no Ciclo N+1". **Só em `rankeando`**: ranqueado/monitoramento/recuperação não trabalham por ciclo de campanha. Se a virada falhar (erro de banco), o marco ainda é emitido — a falha é logada e a troca pode ser feita no botão.
- **Novo ciclo manual** (botão 🔁 no card → `POST /api/ranking/ads/:id/ciclo`, `DB.novoCicloRankingAd`): força a virada **antes** do marco. Usa `ranking.avancarCiclo()` — a mesma função do caminho automático, não uma cópia. Ela arquiva um **snapshot** do ciclo (ADS/ROAS/orçamento/preços + `sales_count` + faturamento acumulados) em `ranking_ciclos`, incrementa `ciclo`, **desloca** `preco_anterior ← preco_atual` e carimba novo `ciclo_iniciado_em`, tudo numa transação com `SELECT … FOR UPDATE` (o worker pode estar processando outra venda do mesmo anúncio). **Não** mexe no contador de vendas. Como o incremento é `ciclo + 1` (e não `sales_count / N + 1`), manual e automático convivem sem brigar pelo número.
- **Marco (múltiplo de N vendas):** como o `sales_count` é cumulativo, o marco dispara a cada N vendas (5,10,15…) e **é ele que vira o ciclo** (ver acima). Em `rankeando` o marco vai forçado ao Telegram; em `ranqueado` conta em silêncio.
- **Filtro de ciclos:** select global `rkCiclo` (topo) populado de 1..maior ciclo em uso — filtra os cards por `r.ciclo` (`GET /api/ranking/ads?...&ciclo`).
- **Fase ranqueado NÃO tem ciclos:** quando o anúncio vira **ranqueado** (já atingiu o nível), o card **esconde** badge de ciclo, botão Novo ciclo, bloco de ADS/preço e histórico — volta ao modo saúde puro (defender/regressão).
- **Histórico:** `<details>` "Ciclos anteriores (N)" no rodapé do card (só em rankeando) carrega sob demanda via `GET /api/ranking/ads/:id/ciclos` (`DB.getRankingCiclos`) — campanha/vendas/faturamento/ROAS/orçamento/preço de cada ciclo encerrado. Só aparece se `ciclos_anteriores > 0`.
- **Modal de histórico de preço:** botão 📈 no card (`abrirPrecoModal`, nas duas fases) abre um modal com **cada mudança de preço e sua data** — vem dos eventos `preco` de `ranking_events` (`{de,para}` + `created_at`), via `GET /api/ranking/ads/:id/precos` (`DB.getRankingPrecos`). Tabela Data / De / Para / Variação (R$ e %). Duas origens alimentam a mesma tabela: mudanças **reais** detectadas pelo webhook de item (`onItemChange`, `detail` sem `manual`) e lançamentos **manuais** (abaixo).
- **Campo "Preço em promoção" + lançamento manual no histórico (v88):** o campo que era rotulado "Preço ant." virou **"Preço em promoção"** (mesma coluna `preco_anterior`, só o rótulo mudou — continua par com "Preço atual"/`preco_atual`). Botão **"📈 Lançar no histórico"** ao lado (`lancarPrecoHistorico`, lê os dois campos direto do DOM — `salvarAds` só faz PATCH, não re-renderiza o card) chama `POST /api/ranking/ads/:id/precos {de,para}` (`DB.registrarRankingPreco`), que grava um evento `preco` em `ranking_events` com `detail:{de,para,manual:true}` — **sem** `ranking.emit()` (sem WS/Telegram: é o usuário documentando o preço da campanha, não um alerta de mudança real detectada). `para` é obrigatório, `de` opcional. Aparece no mesmo modal 📈 acima, junto com as mudanças reais.

## Integração com a Inteligência de Negócio (Vendas por Estágio)

O estágio (`fase`) é consultado, nunca duplicado/editado, pelo módulo BI — tela `bi-rankeamento.html` (Vendas por Estágio) e tag de estágio em `bi-vendas.html`. Fórmulas/limiares dessa integração (por que o estágio mostrado é sempre o ATUAL, nunca reconstruído; antes×depois de Recuperação; score; conversão) ficam em `business-rules.md`, contrato da rota em `api.md` (`GET /api/bi/rankeamento`, `POST /api/ranking/fase-lote`), decisão de design em `decisions.md`.

**Estágio Catálogo entra na mesma análise (v88, pedido explícito do usuário):** `FASES_RANKEAMENTO` (`routes/bi.js`) inclui `'catalogo'` — automaticamente aparece em TODO lugar que já analisa estágio: os 5 blocos de `bi-rankeamento.html` (antes 4), a tabela de comparação, o ranking de score, `produtos_por_estagio`, e o relatório em PDF (`GET /api/bi/rankeamento/relatorio`, ver abaixo). Uma venda de um anúncio alocado em Catálogo passa a bucketizar em `'catalogo'`, não mais em `'sem_rankeamento'`.
