# Integração — Shopee

> Status atual (20/07/2026): **fase 1 concluída e app aprovado ao vivo (produção).** Autenticação (assinatura HMAC + OAuth completo), sincronização de pedidos via polling e dashboard dedicado (`pages/dashboard-shopee.html`). O app `financeecom` foi aprovado para o ambiente **ao vivo** (Live partner ID `2039090`); as credenciais de produção foram para o `server/.env` com `SHOPEE_ENV=production`. O app está como **"Sem acesso a dados sensíveis"**, então `getOrder` não pede `buyer_username`/endereço por padrão (`SHOPEE_SENSITIVE_ACCESS=false`) — ver seção "Ir para produção" abaixo. Falta o usuário autorizar a loja real via `/auth/shopee/login` e reiniciar o worker para o pipeline processar pedidos de produção. Conta de login restrita (`shopee-demo`, ver seção abaixo) foi criada pro revisor da Shopee. Ver a decisão de arquitetura completa em `decisions.md` ("Shopee sai do stub").

## Ir para produção (app aprovado ao vivo — partner_id 2039090)

O app `financeecom` foi aprovado para o ambiente **ao vivo** (Live partner ID `2039090`, categoria "Sistema interno do vendedor", chave da API Live válida até 14/01/27). O código já suporta produção — `baseUrl('production')` → `https://partner.shopeemobile.com`. Para migrar de sandbox → produção:

1. No `server/.env` de produção: `SHOPEE_PARTNER_ID=2039090`, `SHOPEE_PARTNER_KEY=<chave da API Live>` (colar **só no .env**, nunca em chat/log — se vazar, redefinir no console), `SHOPEE_ENV=production`, `SHOPEE_REDIRECT_URI=https://multimixvendas.duckdns.org/auth/shopee/callback` (deve bater exatamente com o cadastrado no console do parceiro **ao vivo**).
2. Confirmar o IP de saída `207.180.194.61` na **Lista de IPs Permitidos do parceiro ao vivo** (allowlist separada da conta de teste).
3. Reiniciar `ml-dashboard-novo` + `ml-worker-novo`; conferir `/auth/shopee/config` (mostra ambiente, host e acesso a dados sensíveis).
4. Autorizar a loja real em `/auth/shopee/login`; reiniciar o worker de novo pro polling pegar a conta nova.

**Acesso a dados sensíveis** (`SHOPEE_SENSITIVE_ACCESS`, default `false`): o app está como **"Sem acesso"** a dados sensíveis. Campos como `buyer_username`/endereço só podem ser pedidos ao `get_order_detail` se esse acesso for aprovado no console — pedir sem permissão **quebra a chamada** em produção. Por isso `getOrder` (em `shopeeClient.js`) só inclui `buyer_username` nos `response_optional_fields` quando `SHOPEE_SENSITIVE_ACCESS=true`; por padrão só pede campos não-sensíveis (`total_amount`, `order_status`, `item_list`, `create_time`, `update_time`). O handler já grava `buyer_username` como `null` quando ausente. Quando/se a Shopee aprovar acesso a dados sensíveis, setar `SHOPEE_SENSITIVE_ACCESS=true` no `.env`.

## Contrato GET × POST (sandbox era tolerante, produção é estrita)

Os endpoints de leitura da Shopee (`order/get_order_list`, `order/get_order_detail`) são **GET com todos os params de negócio no query string**. O sandbox (`partner.uat.shopeemobile.com`) aceitava POST com corpo JSON; a **produção** (`partner.shopeemobile.com`) **não roteia POST nesses paths e retorna 404**. Descoberto ao ativar produção (o polling deu `get_order_list -> HTTP 404` na 1ª chamada). `shopeeClient._call` agora aceita `method: 'GET'` + `query: {...}` (params fora da assinatura), e `getOrder`/`listRecentOrders` usam GET, com `order_sn_list`/`response_optional_fields` como listas separadas por vírgula. Os endpoints de **auth** (`auth/token/get`, `auth/access_token/get`) continuam POST com body — esses sempre foram POST. Regra prática: **auth = POST body, leitura = GET query.**

## O que já existe

- **`server/src/marketplaces/shopee/shopeeClient.js`** — cliente real: `SignatureBuilder` (HMAC-SHA256, base string partner-level vs. shop-level), `getAuthorizationUrl`/`exchangeCodeForToken` (funções partner-level, exportadas separadas da classe porque rodam antes de qualquer loja autorizada), `refreshAccessToken`/`getOrder`/`listRecentOrders` (contrato `MarketplaceClient`, mesmo de `amazonClient.js`).
- **`server/src/marketplaces/shopee/ShopeePollingEventSource.js`** — implementação real do `EventSource`, mesmo molde de `AmazonPollingEventSource.js`: polling a cada 15 min, cursor em `marketplace_sync_state`, renovação proativa de token com CAS (ver `decisions.md`).
- **`server/src/routes/shopeeAuth.js`** (montada em `/auth/shopee`) — fluxo OAuth completo: `GET /config` (diagnóstico), `GET /login` (redireciona pra Shopee), `GET /callback` (troca `code` por tokens, cria/atualiza a linha em `stores`). Ver `api.md`.
- **`server/src/marketplaceEventWorker.js`** — ganhou um segundo `Worker`/fila (`marketplace-events-shopee`) e handler (`handleShopeeOrderEvent`), paralelo ao da Amazon, sem tocar nele. Ver `workers.md`.
- **Migration v18** (`server/src/db/migrate-v18.sql`, espelhada em `schema.sql`) — habilita `marketplaces.SHOPEE` (`enabled=true`, `api_type='polling'`), `stores.shopee_shop_id` (índice único parcial), tabela `shopee_order_data`. Ver `database.md`.
- `env.shopee` em `config/env.js` (`partnerId`, `partnerKey`, `redirectUri`, `env`, `sensitiveAccess`).
- **`ShopeeClient.getTrackingNumber(orderSn)`** (v35) — Logistics API (`logistics/get_tracking_number`, GET). Devolve o rastreio (`BR…`) que está no QR da etiqueta. O worker grava em `shopee_order_data.tracking_number` quando o pedido está embarcável; a **Embalagem** (estação única ML+Shopee) casa a etiqueta bipada por esse campo. Ver `embalagem.md`. Confirmado empiricamente que o `get_tracking_number` devolve exatamente o `BR…` impresso na etiqueta (`server/test-shopee-tracking.js`). O rastreio está no escopo "logistics" que o app já autorizou — **não** é bloqueado pelo "Sem acesso a dados sensíveis".

## Infraestrutura confirmada para o app na Shopee

- **IP de saída do servidor de produção** cadastrado na "Lista de IPs Permitidos" (exigido pela Shopee para qualquer chamada com dado sensível — diferente do ML): `207.180.194.61`, confirmado **fixo** pelo usuário (`curl -4 ifconfig.me`).
- **Domínio de redirect OAuth**: mesmo domínio do Mercado Livre — `https://multimixvendas.duckdns.org`. Path próprio: `/auth/shopee/callback` (`SHOPEE_REDIRECT_URI` no `.env` deve bater **exatamente** com o cadastrado no console da Shopee).
- Domínio é DuckDNS (DNS dinâmico) — IP por trás confirmado fixo pelo usuário.

## Como testar (sandbox)

1. Confirmar `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY`/`SHOPEE_REDIRECT_URI`/`SHOPEE_ENV=sandbox` no `server/.env` de produção.
2. Visitar `https://multimixvendas.duckdns.org/auth/shopee/login` — redireciona pra Shopee, o usuário autoriza a **conta de teste (Sandbox)** disponível no console.
3. A Shopee redireciona de volta pra `/auth/shopee/callback`, que cria a linha em `stores` (`marketplace_id=SHOPEE`, id sintético `9100000001`+, `shopee_shop_id` = o `shop_id` real).
4. **Reiniciar `ml-worker-novo`** — hot-reload de conta nova não existe ainda (mesma limitação já registrada pra Amazon em `todo.md`).
5. Acompanhar `journalctl -u ml-worker-novo -f` por linhas `[shopee-polling]`/`[marketplace-worker]` — a 1ª execução do polling olha as últimas 24h; como o sandbox não gera pedidos reais automaticamente, pode ser necessário criar um pedido de teste pela "Ferramenta de teste" do console pra ver o pipeline processar de ponta a ponta.

## Webhook ("Mecanismo de Empurra") — implementado (tempo real)

Receptor **isolado** do gateway ML: `server/src/routes/shopeeWebhook.js`, montado em **`/webhooks/shopee`** (arquivo/rota/lógica próprios, nada compartilhado com `webhookGateway.js`). Montado **antes** do `express.json()` global (usa `express.raw()` — a assinatura Shopee precisa do corpo cru). Fluxo: responde `200` na hora → valida assinatura → enfileira o **mesmo evento padronizado do polling** (`marketplace-events-shopee`, `jobId` `SHOPEE:ORDER_UPDATED:{storeId}-{orderSn}`) → `handleShopeeOrderEvent` processa igual, só que **em tempo real** (venda cai no dashboard/Telegram na hora, não em até 15 min).

- **Assinatura**: `HMAC-SHA256(chave_de_push, push_url + "|" + raw_body)` no header `Authorization`. **A chave é separada da partner_key da API** — é a **"Chave de parceiro Live Push"** que aparece no próprio console (Mecanismo de Empurra), configurada em `SHOPEE_PUSH_PARTNER_KEY` no `.env` (`env.shopee.pushPartnerKey`; fallback pra `partnerKey` se não setada). Usar a chave errada dá `verified=false`. Se não confere, o push é logado (pra diagnóstico) e **não** é processado, salvo `SHOPEE_WEBHOOK_VERIFY=false` (escape hatch pro 1º teste). Se o formato real divergir, os logs mostram `recebida=… esperada=…` pra ajustar.
- **Handshake de verificação**: ao clicar "Verificar"/cadastrar a `push_url` no console, a Shopee manda `{"code":0,"data":{"verify_info":"...Please respond in the certain format."}}` e espera o **mesmo corpo de volta** (challenge-response por echo), não um `200 "OK"`. O receptor parseia o raw body no topo e, se for essa mensagem (`code=0` + `data.verify_info`), **ecoa o corpo verbatim** com `Content-Type: application/json` — antes do ack genérico e do gate de assinatura (esse ping não traz `order_sn` e não deve ser enfileirado). Sem isso, o botão "Verificar" do console rejeita a URL.
- **Dedup com o polling**: mesmo `jobId` → BullMQ ignora duplicata se os dois dispararem pro mesmo pedido. O polling **continua ligado** como rede de segurança (webhooks podem se perder).
- **Configuração** (usuário): no console Shopee → "Mecanismo de Empurra", cadastrar `push_url = https://multimixvendas.duckdns.org/webhooks/shopee` e habilitar o push de status de pedido. O IP `207.180.194.61` já está na allowlist. Ver `.env.example` (`SHOPEE_WEBHOOK_VERIFY`).

## Financeiro (escrow) + status de entrega — implementados (v36, tela própria)

Página **Financeiro** (`pages/shopee-financeiro.html`, `SHOPEE_NAV_ITEMS`), **isolada da Conciliação Bancária do ML** (pedido do usuário: tudo Shopee separado). Mostra por pedido quanto o comprador pagou (`buyer_total`), o **frete** (`order_income.buyer_paid_shipping_fee`, lido do `escrow_raw` — não virou coluna própria), a **taxa Shopee** (`commission_fee`), o **líquido/repasse** (`escrow_amount` — confirmado no diagnóstico: buyer 53,70 → comissão 8,95 → líquido 43,76), a forma de pagamento e o **status de entrega** (`logistics_status`). KPIs bruto/taxa/líquido, gráfico e tabela com filtro loja/período. Backend `/api/shopee/financeiro`. Dados de `get_escrow_detail` + `get_tracking_info`, gravados pelo worker no bloco `SHOPEE_SHIPPABLE` (ver `workers.md`) e `shopeeClient.getEscrowDetail`/`getTrackingInfo`. Backfill dos pedidos antigos: `server/backfill-shopee-financeiro.js`.

**Chat** (`sellerchat/get_conversation_list`) — **implementado** (v37, tela **Mensagens** própria em `SHOPEE_NAV_ITEMS`). Os parâmetros certos (diagnóstico `test-shopee-chat.js`): `type` + `direction=latest` + `page_size` (o `param_error` 491 inicial era por faltar `type`/`direction`). O worker faz `syncShopeeChat()` a cada `SHOPEE_CHAT_INTERVAL_MS` (10 min): pega as conversas **não lidas** (`type='unread'`), grava em `shopee_chat` e notifica o Telegram (`tg_mensagens`) com dedup por `notified_message_id` **e** guard anti-mensagem-antiga (só notifica se `last_message_timestamp` < 24h — timestamp em nanossegundos, `/1e6` pra ms). Backend `/api/shopee/chat`.

## Webhook — histórico (antes da implementação acima)

A Shopee expõe push de pedido de verdade (confirmado pela KB de referência do usuário e pela existência da seção "Mecanismo de Empurra" no console) — diferente do que a versão anterior deste arquivo especulava. A fase 1 usa **polling mesmo assim** (mesma decisão que a Amazon tomou no início: validar autenticação/formato de chamada sem depender de um endpoint de webhook público testado). Antes de migrar para push:

1. Confirmar no console se "Mecanismo de Empurra" pede uma `push_url` e qual o formato exato de assinatura do payload (a Shopee costuma assinar `url + "|" + body` com a mesma `partner_key`, mas **não deve ser assumido sem checar** — validar contra o portal do parceiro).
2. Implementar o receptor seguindo o mesmo padrão do Gateway ML (`webhookGateway.js`): responder `200` imediato, validar assinatura, enfileirar, processar assíncrono.
3. Manter o polling como rede de segurança mesmo depois de ligar o webhook (webhooks podem falhar/se perder) — não desligar `ShopeePollingEventSource`, só reduzir a frequência se fizer sentido.

## Dashboard dedicado (`pages/dashboard-shopee.html`)

Deixou de ser placeholder — mesmo padrão da Amazon (`dashboard-amazon.html`): página independente (`js/layout-shopee.js`, sidebar/topbar próprios, nunca `js/layout.js`), KPIs (vendas/pedidos hoje, produtos ativos), tabela de últimos pedidos, tabela de produtos (vazia até a Product API ser integrada), card de status da integração. Backend em `server/src/routes/shopee.js` (montado em `/api/shopee`), lê `orders`/`items` filtrando `marketplace_id=SHOPEE` direto — não usa as views `vw_ml_*` nem nenhuma rota do ML. `js/layout-shopee.js` tem 3 itens de menu: **Dashboard**, **Vendas Totais** (`shopee-vendas.html`) e **Anúncios** (`shopee-anuncios.html`).

**`shopee-vendas.html` (Vendas Totais)** e **`shopee-anuncios.html` (Anúncios)** — páginas modernas no padrão das telas ML (Chart.js via CDN, cor Shopee `#ee4d2d`). Vendas: KPIs (vendas/pedidos/ticket médio/cancelados + hoje), gráfico de linha vendas×pedidos por dia, doughnut por status, barra + tabela por loja, filtros de **loja** e **período** (7/15/30/60/90 dias). Anúncios: KPIs (total/ativos/pausados/estoque), doughnut ativos×pausados, tabela de anúncios, filtros de loja e status — hoje vem vazio com nota (catálogo Shopee não sincronizado ainda). Backend em `routes/shopee.js`: `/vendas`, `/anuncios`, `/lojas`, todos com `store_id` opcional. **Multi-loja desde o início:** o seletor de loja (`DB.getShopeeLojas()`) filtra por conta ou agrega todas — nenhuma query é presa a uma única loja, então adicionar mais lojas Shopee (autorizar outra via `/auth/shopee/login`) faz elas aparecerem no seletor e nos agregados automaticamente. As duas páginas estão no allowlist do papel `shopee-demo`.

## Papel de login `shopee-demo` — acesso de revisor externo

Criado especificamente para o processo de aprovação de produção da Shopee Open Platform ("Transmissão ao vivo"), que pede uma URL ativa do produto + credencial de teste. Como `STAFF_AUTH_ENABLED` está ligado em produção, qualquer acesso (inclusive páginas estáticas) exige login — dar uma conta `admin` ao revisor exporia todo o sistema (vendas ML, financeiro, vídeos de embalagem). O papel `shopee-demo` (mesmo padrão de restrição do papel `embalagem`, ver `auth-staff.md`) só enxerga `/pages/dashboard-shopee.html`, `/pages/shopee-vendas.html`, `/pages/shopee-anuncios.html` + `/api/shopee/*` — nada mais. Criado via `node server/scripts/createStaffUser.js <usuario> <senha> shopee-demo`.

## O que NÃO fazer

- Não adicionar um cliente Shopee direto no frontend (violaria a regra de arquitetura — toda leitura passa por `/api/*`).
- Não tentar "adivinhar" nomes de campo/endpoint que não estão confirmados — a Shopee muda contrato entre versões menores; qualquer endpoint novo (produto, logística, financeiro — ainda não implementados) deve ter o campo/nome confirmado no portal do parceiro antes de codificar.
- Não criar uma rota admin manual pra colar `refresh_token` de Shopee (como existe hoje pra Amazon) — a Shopee sempre exige o fluxo OAuth completo pra emitir token; não existe "gerar refresh token" fora dele (ver `decisions.md`).
- Nunca colar `Partner Key`/tokens em chat — só em `server/.env`.

## Chat (mensagens não respondidas) — implementado (v37)

Diagnóstico (`test-shopee-chat.js`) fechou o contrato: `get_conversation_list` exige `type` + `direction=latest` + `page_size` (sem `direction` → `param_error`). `type='unread'` traz só conversas com mensagem não lida.

- `ShopeeClient.getConversationList(type, pageSize)`.
- Job **`syncShopeeChat`** (`marketplaceEventWorker`, a cada 10min, isolado do ML): busca conversas não lidas, grava em `shopee_chat` (dedup por `notified_message_id`, e guarda o `to_id` do comprador — v38) e notifica no **Telegram** (`tg_mensagens`) as novas — **com guard de 24h** (`last_message_timestamp` em nanossegundos; conversa antiga é marcada como notificada sem mandar Telegram, pra não spammar no 1º run).
- Página **Mensagens** (`pages/shopee-chat.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): KPIs + lista de conversas. Clicar numa conversa abre um **drawer com o histórico** (`get_message_list`) e uma **caixa de resposta** — dá pra **responder o cliente dentro da plataforma** (não é mais só leitura). Toggle "mostrar já respondidas" (`?todas=1`) pra reabrir conversas antigas. Backend `/api/shopee/chat`, `/api/shopee/chat/:id/mensagens`, `/api/shopee/chat/responder`.

### Responder dentro da plataforma (send_message) — v38

- `ShopeeClient.getMessageList(conversationId, pageSize)` (GET, histórico) e `ShopeeClient.sendMessage(toId, text)` (**POST** — escrita — `sellerchat/send_message`, body `{to_id, message_type:'text', content:{text}}`; `toId` é o `user_id` do comprador vindo do `to_id` da conversa).
- Helper `getShopeeClientForStore(pool, storeId, env.shopee)` (em `shopeeClient.js`): constrói o client da loja dona da conversa e **renova o token proativamente com CAS** (mesma disciplina do `ShopeePollingEventSource._ensureValidToken`, mas pontual pra rota). O `shopeeClient.js` continua sem conhecer o banco — o `pool` é injetado.
- ⚠️ O `send_message` pode exigir **"Acesso a dados sensíveis"** aprovado no console (o mesmo `SHOPEE_SENSITIVE_ACCESS`). Se a Shopee recusar, o erro de negócio dela é repassado ao front (a UI mostra o motivo). Confirmar o formato real do histórico com `server/test-shopee-chat-msg.js` (read-only).
- Tabela `shopee_chat` (v37) + coluna `to_id` (v38) — ver `database.md`.

## Catálogo (Product API) — implementado (v39, fundação)

Sync do catálogo Shopee → **`items`** (campos comuns, reaproveitando a tabela do ML) + **`shopee_item_data`** (SKU, variações/models com preço+estoque por variação, descrição). É a **fundação** de anúncios, precificador, estoque em massa, SEO, TaskEngine e promoções (todos leem daqui).

- **Client** (`shopeeClient.js`): `listAllItems(status)` (pagina `product/get_item_list`, `offset`/`page_size`/`item_status`), `getItemsBaseInfo(ids)` (lotes de 50 — nome/SKU/categoria/status/descrição/imagem), `getModelList(itemId)` (**fonte autoritativa de preço/estoque** — `price_info[].current_price`, `stock_info_v2.summary_info.total_available_stock`, por variação).
- **Job `syncShopeeCatalog`** (`marketplaceEventWorker`, a cada `SHOPEE_CATALOG_INTERVAL_MS`=30min, isolado do ML): pra cada loja, lista itens ativos → base_info em lote → model_list por item → upsert em `items` (title/price=menor preço/available_quantity=estoque somado/status NORMAL→active/category_id/thumbnail) e `shopee_item_data` (item_sku, has_model, variation_count, price_min/max, stock_total, models[], tier_variation). Delay entre chamadas (rate limit).
- **Página Anúncios** (`pages/shopee-anuncios.html`) deixou de ser placeholder: lista os itens reais com **foto**, SKU, badge de **nº de variações**, faixa de preço (min–max quando tem variação), estoque (destaque vermelho ≤3), status. Backend `/api/shopee/anuncios` (LEFT JOIN `shopee_item_data`).
- Confirmação empírica dos campos: `server/test-shopee-produtos.js` (read-only).
- Tabela `shopee_item_data` (v39) — ver `database.md`.

## Estoque & Preço em massa — implementado (tela própria, ESCRITA)

Página **Estoque & Preço** (`pages/shopee-precos-estoque.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): grade com um bloco por produto e uma linha editável **por variação** (preço + estoque). Edita vários, mostra "N campos alterados", e **Aplicar alterações** grava tudo de uma vez.

- **Client** (ESCRITA — POST): `updatePrice(itemId, [{model_id, price}])` (`product/update_price`, `original_price`) e `updateStock(itemId, [{model_id, stock}])` (`product/update_stock`, `seller_stock:[{stock}]`). `model_id=0` pra item sem variação.
- **Rotas**: `GET /api/shopee/estoque-preco` (itens + variações do espelho local `shopee_item_data`, filtro loja/busca) e `POST /api/shopee/anuncios/aplicar` (`{changes:[{item_id,model_id,price?,stock?}]}` — agrupa por item, grava na Shopee, atualiza o espelho local na hora via `updateLocalItemAfterWrite` pra não esperar o sync de 30min).
- ⚠️ **Escrita real** — altera preço/estoque da loja. Verificação empírica do contrato sem alterar nada: `server/test-shopee-update.js` (regrava o estoque com o mesmo valor = no-op). Roda uma vez antes de confiar na tela.

## Dashboard Executivo — implementado (KPIs no dashboard-shopee)

O **dashboard-shopee** (tela inicial) ganhou os KPIs executivos de hoje: **Faturamento** (vendas), **Pedidos**, **Lucro**, **Ticket Médio**, **Margem** (+ Produtos). Backend `GET /api/shopee/executivo?store_id&dias` (0=hoje):
- **Lucro = líquido do escrow − custo**. Líquido = `SUM(escrow_amount)` (após taxa Shopee real); pedidos sem escrow ainda (muito recentes) estimam o líquido pela **taxa efetiva** (`escrowFeePct`). Custo = `AVG(shopee_item_cost)` por item × quantidade (custo digitado no Precificador).
- **Transparência**: retorna `pedidos_com_custo`/`custo_completo` — se nem todo pedido tem custo cadastrado, o dashboard mostra "⚠ parcial: X/Y c/ custo" no Lucro (não finge que o lucro é exato).
- **Margem** = lucro/faturamento. **Ticket** = faturamento/pedidos.

## Painel de Problemas — implementado (tela própria)

Página **Painel de Problemas** (`pages/shopee-problemas.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): cards do que precisa de ação na Shopee, cada um expansível com a amostra dos itens. Tudo `marketplace_id=SHOPEE` (isolado do ML). Backend `GET /api/shopee/problemas?store_id`.

- **Pedidos atrasados**: pagos, `date_created < now−2 dias` e `logistics_status` ainda não despachado (não em DELIVERY/REQUEST/PICKUP_DONE). Aproximado (não temos o prazo RTS exato da Shopee).
- **Anúncios pausados** (`status='paused'`), **Sem estoque** (`available_quantity=0` ativos), **Sem imagem** (`thumbnail` vazio), **Pedidos cancelados** (30 dias).
- **Reclamações/reembolsos**: expostos como **indisponíveis** (dependem da Returns API da Shopee, ainda não integrada) — pra não mostrar número falso.

## Promoções — implementado (tela própria + alerta Telegram)

Página **Promoções** (`pages/shopee-promocoes.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): acompanha descontos e vouchers com **contagem regressiva pro prazo** e alerta de vencimento.

- **Client**: `getDiscountList(status)` (`discount/get_discount_list`, pagina via `more`) e `getVoucherList(status)` (`voucher/get_voucher_list`). Campos confirmados em `test-shopee-promo.js`: desconto = `discount_id/discount_name/start_time/end_time/status`; voucher = `voucher_id/voucher_name/voucher_code/start_time/end_time/reward_type(1=valor,2=%)/percentage|discount_amount/current_usage/usage_quantity`.
- **Job `syncShopeePromos`** (`marketplaceEventWorker`, a cada `SHOPEE_PROMO_INTERVAL_MS`=1h): busca descontos (ongoing+upcoming) e vouchers (não expirados), upsert em `shopee_promotions`, e **alerta no Telegram** (`tg_vendas`) as promoções ativas que vencem em < `SHOPEE_PROMO_ALERT_HOURS`=24h — dedup por `expiry_notified` (rearma se a promoção for estendida).
- **Rota** `GET /api/shopee/promocoes?store_id&tipo`: lê `shopee_promotions`, recalcula status na hora, KPIs (ativas/agendadas/vencendo 24h). A contagem regressiva é client-side (atualiza a cada 1min sem refetch).
- Tabela `shopee_promotions` (v41) — ver `database.md`.

## Precificador — implementado (tela própria)

Página **Precificador** (`pages/shopee-precificador.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): calcula o **preço ideal por variação** a partir de custo + margem + taxa, e aplica com 1 clique (reusa o `/anuncios/aplicar`).

- **Fórmula**: `preço_sugerido = (custo + taxa_fixa) / (1 − taxa% − margem%)` (margem sobre o preço de venda). Mostra também a **margem atual** no preço vigente (verde/vermelho).
- **Custo** (decisão do usuário): **digitado na tela**, salvo em `shopee_item_cost` (v40) **por variação** (`item_id`+`model_id`) — tabela separada de propósito, porque o sync de catálogo reescreve `shopee_item_data.models` a cada 30min. Rota `POST /api/shopee/custo`.
- **Taxa Shopee** (decisão do usuário): **automática do escrow** — `escrowFeePct()` calcula a taxa efetiva real (`SUM(commission_fee)/SUM(buyer_total)` de `shopee_order_data`), pré-preenchida e editável; cai pra 14% se ainda não há escrow. Rota `GET /api/shopee/precificador` (margem/taxa/taxa_fixa por query).
- Tabela `shopee_item_cost` (v40) — ver `database.md`.

## Lojas — implementado (tela própria)

Página **Lojas** (`pages/shopee-lojas.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`) — identifica as lojas Shopee registradas, no mesmo padrão visual da página de Lojas do ML (`pages/lojas.html`), mas isolada e com a identidade Shopee (laranja `#ee4d2d`, ícone de sacola). Grid de cards, um por loja, mostrando: `shop_id` real + id interno, status **Autorizada/Sem autorização** (`refresh_token IS NOT NULL`), validade do token de acesso (`token_valid`/`token_expires_at` — o polling renova sozinho pelo refresh_token), última atualização, e métricas por loja (**pedidos total/mês**, **faturamento do mês**, **produtos ativos**). Loja sem autorização mostra botão **Autorizar loja** → `/auth/shopee/login` (mesmo OAuth do console). Backend: `GET /api/shopee/lojas` (enriquecida — ver `api.md`), consumida por `DB.getShopeeLojas()`. Multi-loja de fábrica: cada linha de `stores` com `marketplace_id=SHOPEE` vira um card.

**Renomear a loja**: cada card tem um campo pra editar o **nome da loja** (`PATCH /api/shopee/lojas/:id` → `stores.nickname`, `DB.renomearShopeeLoja`). Como chat/vendas/pedidos/financeiro leem `s.nickname AS conta`, esse é o **nome que aparece em todos os relatórios e no chat** — é "o novo nome da loja". Seguro: o `nickname` só é definido na criação (`Shopee {shop_id}`) e **nunca é sobrescrito** pelo worker/refresh de token/reautorização, então o nome renomeado persiste.
