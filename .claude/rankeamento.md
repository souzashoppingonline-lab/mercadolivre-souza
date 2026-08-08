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
| `destaque` | `snapshot` (v70) | entrou/saiu/mudou de posição nos **Mais Vendidos** da categoria (`mlClient.getCategoryHighlights` → `/highlights/MLB/category/:cat`); casa por item id (`type ITEM`) ou `catalog_product_id` (`type PRODUCT`); posição em `ranking_ads.last_highlight_pos` |

Preço/estoque/status vêm **de graça** do webhook de item (sem GET extra). Visitas/qualidade/buy-box não têm webhook → job periódico só dos anúncios ativos (poucos, limite `MAX_ADS=30`), sem varrer o catálogo, então não pesa no rate limit do ML.

## Semente anti-alerta-falso

Ao marcar um anúncio (`POST /ads`), os `last_price`/`last_available_quantity`/`last_status` são semeados a partir de `items`, e `base_price` guarda o preço de referência. Assim a 1ª alteração real dispara evento (não a leitura inicial). `onItemChange` também atualiza os `last_*` mesmo sem evento, para semear anúncios recém-marcados.

## Regras / limites

- **Marco a cada N vendas**: `milestone_every` por anúncio (default 5, editável no `POST`/`PATCH`).
- **Duração**: fica ativo até o usuário **remover** (DELETE, apaga histórico via CASCADE) ou **pausar** (`active=false`, mantém histórico, para de notificar). Não auto-desliga.
- **Limite**: `MAX_ADS=30` anúncios ativos (o snapshot roda por anúncio ativo — trava de proteção).
- **Silêncio/throttle do Telegram**: eventos `venda` e `marco` usam `tgNotifyForce` (ignoram silêncio/throttle) — a mensagem "Venda de produto em rankeamento" **sempre** sai logo depois do alerta de venda normal (`tg_vendas`). Os demais eventos (`preco`/`estoque`/`status`/`visitas`/`qualidade`/`buybox`/`destaque`) usam `tgNotify` (respeitam silêncio/intervalo). Ativar/desativar o tópico: chave `tg_rankeamento` em `app_config` — só afeta os eventos não-forçados (venda/marco ignoram, por serem o núcleo da feature).

## Página `pages/rankeamento.html`

Duas partes: (1) **cards dos anúncios em rankeamento** no topo — badge "Anúncio em rankeamento", contador com barra de progresso 5-em-5, stats (faturamento/visitas/estoque/preço) e **timeline venda-a-venda ao vivo** (WS `ranking_event` insere no topo na hora); botões pausar/remover. (2) **tabela com todos os anúncios** (busca por título/MLB) com botão "Acompanhar" que promove o anúncio a card. Métodos em `js/db.js`: `getRankingAds`, `buscarRankingItems`, `addRankingAd`, `patchRankingAd`, `removeRankingAd`, `getRankingEventos`.
