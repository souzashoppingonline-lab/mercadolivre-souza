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

**Níveis de progressão (v78):** anúncio em **RANQUEADO** exibe seu **Nível** (1 + floor(sales_count / 10)) — a cada 10 vendas acumuladas, sobe de nível (Nível 1, Nível 2, Nível 3…). Também mostra **Devoluções** (contagem de `returns` com `item_id` = ml_id do anúncio), colorida em verde (nenhuma) ou vermelho (com devoluções) — só visível em RANQUEADO.

A página tem 4 abas: **Em rankeamento**, **Ranqueados**, **Monitoramento** (ver abaixo) e **Todos os anúncios** (tabela de seleção).

## Três estágios + mudança manual (v76)

Além de `rankeando` e `ranqueado`, existe o 3º estágio **`monitoramento`**: um produto que **já ranqueou mas caiu**, no qual foram feitas alterações e agora se acompanha o efeito. A transição entre os 3 é **manual**, por um **seletor de estágio** (`<select>`) no card (`mudarFase` → `PATCH /ads/:id {fase}`). Regras do carimbo: `→ranqueado` seta `ranqueado_em=now()`, `→rankeando` limpa, `→monitoramento` seta `monitoramento_started_at=now()` (v77 — rastreia quando entrou em monitoramento). **Contador de dias:** adapta-se por fase — "X dias em rankeamento" (fases 1/2, baseado em `started_at`), "X dias em monitoramento" (fase 3, baseado em `monitoramento_started_at`). Layout de `monitoramento` = modo saúde (igual ranqueado) + um **banner âmbar** e o log de alterações. Cores dos badges: rankeando amarelo, ranqueado verde, monitoramento âmbar (#f59e0b).

**Log de alterações (`ranking_notes`):** cada card tem um botão **📋 Alterações** (ícone `clipboard-list`, com contador `notas_count`) que abre um modal para **escrever e ler** anotações livres do que foi mudado (baixei preço, troquei foto, ajustei título…), cada uma com data. Rotas `/ads/:id/notas` (GET/POST/DELETE), métodos `DB.getRankingNotas`/`addRankingNota`/`delRankingNota`. Disponível em qualquer fase, mas é o centro do estágio Monitoramento. As vendas em `monitoramento` contam em silêncio (como ranqueado).

## Multi-canal (ML + Shopee)

Anúncios e pedidos das duas plataformas vivem nas mesmas tabelas `items`/`orders` (discriminados por `marketplace_id`), então o rankeamento serve os dois. A página tem um filtro **Todos os canais / Mercado Livre / Shopee** (`?marketplace=` em `/ranking/ads` e `/ranking/buscar`) e um selo de canal em cada card/linha.

- **Vendas Shopee**: `handleShopeeOrderEvent` (`marketplaceEventWorker.js`) chama `ranking.onSale` por item do `item_list` (mesma guarda anti-pedido-antigo de 24h). Venda + contador 5-em-5 + marco funcionam igual ao ML.
- **Faturamento do marco**: somado dos próprios `ranking_events` (campo `detail.valor`), não de `orders.item_id` — a Shopee não popula `item_id` em `orders`, então essa era a única forma agnóstica.
- **Limitações Shopee (hoje)**: o snapshot `sync-ranking` (visitas/qualidade/buy-box/destaque) roda **só para anúncios ML** (usa a API do ML); e preço/estoque/status **não** notificam para Shopee (o hook `onItemChange` está só no `handleItem` do pipeline ML). Shopee recebe venda/marco em tempo real; o resto é gap conhecido.

## Avisos de Revisão de ADS (v79)

Um card pode agendar **múltiplos avisos** via Telegram para revisar os ADS — agenda uma data/hora, opcionalmente com observação. Tabela `ranking_ads_alerts` grava os avisos agendados. Job `syncRankingAlerts` (1x/h no worker) verifica avisos que chegaram à hora, dispara via Telegram (forçado, independente de silêncio) e marca `notified_at`. Modal na página com datetime-picker e formulário de observação; lista os avisos agendados (com status ✅/⏰). Rotas: `GET /api/ranking/ads/:id/alerts` (listar), `POST /api/ranking/ads/:id/alerts` (agendar).

## Página `pages/rankeamento.html`

Duas partes: (1) **cards dos anúncios em rankeamento** no topo — badge "Anúncio em rankeamento", contador com barra de progresso 5-em-5, stats (faturamento/visitas/estoque/preço) e **timeline venda-a-venda ao vivo** (WS `ranking_event` insere no topo na hora); botões pausar/remover + **🔔 Aviso ADS** (agendar lembrete). (2) **tabela com todos os anúncios** (busca por título/MLB) com botão "Acompanhar" que promove o anúncio a card. Métodos em `js/db.js`: `getRankingAds`, `buscarRankingItems`, `addRankingAd`, `patchRankingAd`, `removeRankingAd`, `getRankingEventos`, `getRankingAlerts`, `agendarRankingAlert`.

**Filtro por empresa/loja (ML):** select global `rkLoja` (topo, ao lado das abas) populado por `GET /api/lojas` (`DB.getLojas`) — filtra os cards (rankeando/ranqueado) **e** a tabela por `store_id`. As rotas `GET /api/ranking/ads?...&store_id` e `GET /api/ranking/buscar?...&store_id` aceitam o filtro (`r.store_id`/`i.store_id`). Cada card já mostra a loja (`store_nickname`).

## Ciclos de rankeamento + métricas de ADS (v72/v73)

Um anúncio **em rankeamento** passa por **ciclos** (campanhas/empurrões sucessivos). O card mostra o **Ciclo N** atual (badge 🔄 azul, em destaque no topo) e campos **preenchidos manualmente** — **nome da campanha** (texto), ROAS, orçamento diário (R$) e a transição de preço (**preço anterior → preço atual**) — porque o ML não expõe esses dados por webhook. Colunas em `ranking_ads`: `ciclo`, `campanha_nome`, `roas`, `orcamento_diario`, `preco_anterior`, `preco_atual`, `ciclo_iniciado_em` (ver `database.md`). `ads_investido` (v72) ficou legado — saiu do card, substituído pelo nome da campanha (v74).

- **Vendas são cumulativas:** o contador (5-em-5), `sales_count` e o `faturamento` **contam através dos ciclos** — trocar de ciclo **não zera** nada. O ciclo é só um rótulo de fase de campanha.
- **Salvar manual:** cada input salva no `onchange` via `PATCH /api/ranking/ads/:id` (`DB.patchRankingAd`) — sem re-render, pra não perder o foco. Dicas no card: **ROAS calculado** (faturamento ÷ ADS) e a seta de preço (↑/↓/=); os campos continuam manuais (fonte de verdade).
- **Novo ciclo** (botão 🔁 no card → `POST /api/ranking/ads/:id/ciclo`, `DB.novoCicloRankingAd`): arquiva um **snapshot** do ciclo (ADS/ROAS/orçamento/preços + `sales_count` + faturamento acumulados) em `ranking_ciclos`, incrementa `ciclo`, **desloca** `preco_anterior ← preco_atual` (você informa o novo preço atual) e carimba novo `ciclo_iniciado_em`. **Não** mexe no contador de vendas.
- **Marco (múltiplo de N vendas):** como o `sales_count` é cumulativo, o marco dispara a cada N vendas (5,10,15…) e a mensagem do Telegram inclui **"🔄 avalie trocar o ciclo manualmente no card"** — a troca é sempre manual, nunca automática. Em `rankeando` o marco vai forçado ao Telegram; em `ranqueado` conta em silêncio.
- **Filtro de ciclos:** select global `rkCiclo` (topo) populado de 1..maior ciclo em uso — filtra os cards por `r.ciclo` (`GET /api/ranking/ads?...&ciclo`).
- **Fase ranqueado NÃO tem ciclos:** quando o anúncio vira **ranqueado** (já atingiu o nível), o card **esconde** badge de ciclo, botão Novo ciclo, bloco de ADS/preço e histórico — volta ao modo saúde puro (defender/regressão).
- **Histórico:** `<details>` "Ciclos anteriores (N)" no rodapé do card (só em rankeando) carrega sob demanda via `GET /api/ranking/ads/:id/ciclos` (`DB.getRankingCiclos`) — campanha/vendas/faturamento/ROAS/orçamento/preço de cada ciclo encerrado. Só aparece se `ciclos_anteriores > 0`.
- **Modal de histórico de preço:** botão 📈 no card (`abrirPrecoModal`, nas duas fases) abre um modal com **cada mudança de preço e sua data** — vem dos eventos `preco` de `ranking_events` (`{de,para}` + `created_at`, mudanças reais detectadas pelo webhook de item), via `GET /api/ranking/ads/:id/precos` (`DB.getRankingPrecos`). Tabela Data / De / Para / Variação (R$ e %).
