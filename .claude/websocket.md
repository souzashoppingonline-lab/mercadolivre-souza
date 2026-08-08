# WebSocket

> Escopo: como eventos em tempo real chegam do worker até o browser. Para o significado de negócio de cada evento (quando ele deve disparar), ver `business-rules.md`. Para o mecanismo de pub/sub no Redis em si, ver `redis.md`.

## Por que Redis pub/sub entre server e worker

O servidor HTTP (que mantém as conexões WebSocket abertas) e o worker BullMQ (que sabe quando algo mudou) são **processos diferentes**, possivelmente em máquinas diferentes. Para o worker conseguir "empurrar" um evento para os browsers conectados no processo do servidor, ele publica no canal Redis `ml:ws:broadcast`; o servidor está inscrito nesse canal e retransmite para todos os sockets abertos.

```
worker.js → publish(topic, payload) → redis.publish('ml:ws:broadcast', JSON) 
  → server.js (subscriber) → para cada socket aberto → socket.send(JSON)
```

## Servidor — `server/src/ws/hub.js`

- `attach(server)`: cria `WebSocket.Server({ server, path: '/ws' })`, registra cada conexão em um `Set` de clients.
- Ping nativo WS a cada 30s para manter a conexão viva atrás de proxy/nginx (complementar ao ping em nível de aplicação feito pelo cliente — ver abaixo).
- Assina o canal Redis via `redis.duplicate()` (uma segunda conexão dedicada a subscribe, já que `ioredis` não permite comandos normais numa conexão em modo subscriber).
- `publish(topic, payload)`: função exportada, chamada pelo worker após cada gravação relevante no Postgres.
- Mensagem recebida do cliente com `{ type: 'ping' }` recebe `{ topic: 'pong', payload: {} }` de volta (heartbeat de aplicação, distinto do ping/pong nativo do protocolo WS).

**Nginx**: sem configuração de proxy adequada (`proxy_read_timeout` alto, `Upgrade`/`Connection` headers), o nginx fecha conexões WS ociosas em 60s. Config de referência em `server/nginx-websocket.conf`, aplicada em produção — ver `deployment.md`.

## Cliente — `js/websocket.js`

Objeto `WS` singleton (`frontend.md` documenta a API pública `WS.on`/`WS.off`). Detalhes de reconexão:
- Backoff exponencial 2s → 30s (dobra a cada desconexão, reseta ao conectar com sucesso).
- Heartbeat de aplicação: envia `{ type: 'ping' }` a cada 25s; se não recebe `pong` em 60s, força `socket.close()` (que dispara reconexão).
- Tópico interno `_connected` / `_disconnected` — usado por `layout.js` para atualizar o indicador visual de status e por várias páginas para recarregar dados ao reconectar.

## Catálogo de tópicos

| Tópico | Publicado por (handler em `worker.js`) | Payload | Consumido em |
|---|---|---|---|
| `order_updated` | `handleOrder`, `handleShipment` | `{ id, status }` ou `{ shipment_id }` | `dashboard.js`, `pages/pedidos.html`, `pages/vendas*.html` |
| `nova_venda` | `handleOrder` (só na transição real p/ `paid` e venda < 24h — **mesma guarda anti-pedido-antigo do Telegram `tg_vendas`**; não dispara em importação em massa `silent`) | `{ marketplace:'ML', loja, titulo, valor, comprador, order_id }` | `layout.js` (`initAlerts`): **som do ML** (`/sounds/ml-venda.mp3` ou arpejo sintetizado fallback) + toast verde + notificação nativa. Presente em toda página |
| `question_received` | `handleQuestion`, também emitido por `webhookGateway.js` ao processar reply do Telegram | `{ id, status, text }` | `layout.js` (alerta sonoro), `pages/perguntas.html` |
| `message_received` | `handleMessage` | `{ pack_id }` | `layout.js` (alerta sonoro), `pages/mensagens.html` |
| `anuncio_updated` | `handleItem`, `syncPrecos` | `{ id, status }` ou `{ sync: 'precos' }` | `pages/anuncios.html`, `pages/produtos.html` |
| `stock_alert` | `handleItem` (quando `available_quantity <= 5`) | `{ id, title, stock, loja }` | `dashboard.js`, `pages/reposicao.html` |
| `webhook_received` | `webhookGateway.js` (todo POST `/webhooks/ml` recebido, antes mesmo do processamento) | `{ topic, resource, store_id, status: 'pending' }` | `pages/webhook.html` |
| `promo_changed` | `handleOffer` | `{ store_id, offer_id, item_id, item_title, status, previous_status, promo_price, original_price, discount_pct }` | `pages/promocoes.html` |
| `devolucao_recebida` | `handlePostPurchase` | `{ store_id, claim_id, status }` | `pages/devolucoes.html` |
| `ranking_event` | `server/src/ranking.js` (`emit`), disparado por `handleOrder`/`handleItem`/job `sync-ranking` | `{ ranking_ad_id, ml_id, title, event_type, message, detail, id, created_at }` — `event_type ∈ venda\|marco\|preco\|estoque\|status\|visitas\|qualidade\|buybox\|destaque\|esfriou` | `pages/rankeamento.html` (timeline venda-a-venda ao vivo). Ver `rankeamento.md` |
| `kpis_updated` | **listado no `CLAUDE.md` original e no cliente `websocket.js` como tópico esperado, mas nenhum handler do worker o publica atualmente** — ver `known-bugs.md` | — | `dashboard.js` está inscrito, mas nunca recebe este evento na prática (o dashboard se atualiza via `order_updated`/`stock_alert`/polling de 60s, não via `kpis_updated`) |

Sempre que um novo handler publicar um tópico novo (ou um tópico existente ganhar campos no payload), atualize a tabela acima na mesma tarefa.

## Tópico `print:{station_id}` (Print Agent)

Publicado por `POST /api/print/jobs` (`routes/print.js`) via `wsHub.publish` quando uma etiqueta é enfileirada, pra o agente da estação acordar na hora. Payload `{jobId, shipping_id}`. O agente também faz polling de `GET /print-agent/jobs/next` como caminho garantido (o WS é só o sinal de baixa latência). Ver `.claude/print-agent.md`.
