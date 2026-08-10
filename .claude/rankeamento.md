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

**Transição manual** (`PATCH /api/ranking/ads/:id {fase}`): botão "Marcar como ranqueado" / "Voltar pra rankeamento". Passar pra `ranqueado` carimba `ranqueado_em`; voltar limpa. A rota `/ads` devolve `sugerir_ranqueado` (bool) — sugere quando bate qualquer critério objetivo (entrou nos Mais Vendidos **ou** ganhou buy-box **ou** ≥ 10 vendas **ou** ≥ 15 dias); quem confirma é o usuário (nunca automático). Novo evento `esfriou` 💤.

A página tem 3 abas: **Em rankeamento** (cards venda-a-venda + chip de sugestão), **Ranqueados** (cards em modo saúde: posição/buy-box/visitas/qualidade + timeline só de regressão), **Todos os anúncios** (tabela de seleção).

## Multi-canal (ML + Shopee)

Anúncios e pedidos das duas plataformas vivem nas mesmas tabelas `items`/`orders` (discriminados por `marketplace_id`), então o rankeamento serve os dois. A página tem um filtro **Todos os canais / Mercado Livre / Shopee** (`?marketplace=` em `/ranking/ads` e `/ranking/buscar`) e um selo de canal em cada card/linha.

- **Vendas Shopee**: `handleShopeeOrderEvent` (`marketplaceEventWorker.js`) chama `ranking.onSale` por item do `item_list` (mesma guarda anti-pedido-antigo de 24h). Venda + contador 5-em-5 + marco funcionam igual ao ML.
- **Faturamento do marco**: somado dos próprios `ranking_events` (campo `detail.valor`), não de `orders.item_id` — a Shopee não popula `item_id` em `orders`, então essa era a única forma agnóstica.
- **Limitações Shopee (hoje)**: o snapshot `sync-ranking` (visitas/qualidade/buy-box/destaque) roda **só para anúncios ML** (usa a API do ML); e preço/estoque/status **não** notificam para Shopee (o hook `onItemChange` está só no `handleItem` do pipeline ML). Shopee recebe venda/marco em tempo real; o resto é gap conhecido.

## Página `pages/rankeamento.html`

Duas partes: (1) **cards dos anúncios em rankeamento** no topo — badge "Anúncio em rankeamento", contador com barra de progresso 5-em-5, stats (faturamento/visitas/estoque/preço) e **timeline venda-a-venda ao vivo** (WS `ranking_event` insere no topo na hora); botões pausar/remover. (2) **tabela com todos os anúncios** (busca por título/MLB) com botão "Acompanhar" que promove o anúncio a card. Métodos em `js/db.js`: `getRankingAds`, `buscarRankingItems`, `addRankingAd`, `patchRankingAd`, `removeRankingAd`, `getRankingEventos`.

**Filtro por empresa/loja (ML):** select global `rkLoja` (topo, ao lado das abas) populado por `GET /api/lojas` (`DB.getLojas`) — filtra os cards (rankeando/ranqueado) **e** a tabela por `store_id`. As rotas `GET /api/ranking/ads?...&store_id` e `GET /api/ranking/buscar?...&store_id` aceitam o filtro (`r.store_id`/`i.store_id`). Cada card já mostra a loja (`store_nickname`).

## Ciclos de rankeamento + métricas de ADS (v72/v73)

Um anúncio **em rankeamento** passa por **ciclos** (campanhas/empurrões sucessivos). O card mostra o **Ciclo N** atual (badge 🔄 azul, em destaque no topo) e campos **preenchidos manualmente** — **nome da campanha** (texto), ROAS, orçamento diário (R$) e a transição de preço (**preço anterior → preço atual**) — porque o ML não expõe esses dados por webhook. Colunas em `ranking_ads`: `ciclo`, `campanha_nome`, `roas`, `orcamento_diario`, `preco_anterior`, `preco_atual`, `ciclo_iniciado_em` (ver `database.md`). `ads_investido` (v72) ficou legado — saiu do card, substituído pelo nome da campanha (v74).

- **Vendas são cumulativas:** o contador (5-em-5), `sales_count` e o `faturamento` **contam através dos ciclos** — trocar de ciclo **não zera** nada. O ciclo é só um rótulo de fase de campanha.
- **Salvar manual:** cada input salva no `onchange` via `PATCH /api/ranking/ads/:id` (`DB.patchRankingAd`) — sem re-render, pra não perder o foco. Dicas no card: **ROAS calculado** (faturamento ÷ ADS) e a seta de preço (↑/↓/=); os campos continuam manuais (fonte de verdade).
- **Novo ciclo** (botão 🔁 no card → `POST /api/ranking/ads/:id/ciclo`, `DB.novoCicloRankingAd`): arquiva um **snapshot** do ciclo (ADS/ROAS/orçamento/preços + `sales_count` + faturamento acumulados) em `ranking_ciclos`, incrementa `ciclo`, **desloca** `preco_anterior ← preco_atual` (você informa o novo preço atual) e carimba novo `ciclo_iniciado_em`. **Não** mexe no contador de vendas.
- **Marco (múltiplo de N vendas):** como o `sales_count` é cumulativo, o marco dispara a cada N vendas (5,10,15…) e a mensagem do Telegram inclui **"🔄 avalie trocar o ciclo manualmente no card"** — a troca é sempre manual, nunca automática. Em `rankeando` o marco vai forçado ao Telegram; em `ranqueado` conta em silêncio.
- **Filtro de ciclos:** select global `rkCiclo` (topo) populado de 1..maior ciclo em uso — filtra os cards por `r.ciclo` (`GET /api/ranking/ads?...&ciclo`).
- **Fase ranqueado NÃO tem ciclos:** quando o anúncio vira **ranqueado** (já atingiu o nível), o card **esconde** badge de ciclo, botão Novo ciclo, bloco de ADS/preço e histórico — volta ao modo saúde puro (defender/regressão).
- **Histórico:** `<details>` "Ciclos anteriores (N)" no rodapé do card (só em rankeando) carrega sob demanda via `GET /api/ranking/ads/:id/ciclos` (`DB.getRankingCiclos`) — vendas/faturamento/ADS/ROAS/orçamento/preço de cada ciclo encerrado. Só aparece se `ciclos_anteriores > 0`.
