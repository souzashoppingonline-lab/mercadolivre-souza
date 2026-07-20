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

- **Assinatura**: `HMAC-SHA256(partner_key, push_url + "|" + raw_body)` no header `Authorization`. Se não confere, o push é logado (pra diagnóstico) e **não** é processado, salvo `SHOPEE_WEBHOOK_VERIFY=false` (escape hatch pro 1º teste). Se o formato real divergir, os logs mostram `recebida=… esperada=…` pra ajustar.
- **Dedup com o polling**: mesmo `jobId` → BullMQ ignora duplicata se os dois dispararem pro mesmo pedido. O polling **continua ligado** como rede de segurança (webhooks podem se perder).
- **Configuração** (usuário): no console Shopee → "Mecanismo de Empurra", cadastrar `push_url = https://multimixvendas.duckdns.org/webhooks/shopee` e habilitar o push de status de pedido. O IP `207.180.194.61` já está na allowlist. Ver `.env.example` (`SHOPEE_WEBHOOK_VERIFY`).

## Financeiro (escrow) + status de entrega — implementados (v36, tela própria)

Página **Financeiro** (`pages/shopee-financeiro.html`, `SHOPEE_NAV_ITEMS`), **isolada da Conciliação Bancária do ML** (pedido do usuário: tudo Shopee separado). Mostra por pedido quanto o comprador pagou (`buyer_total`), o **frete** (`order_income.buyer_paid_shipping_fee`, lido do `escrow_raw` — não virou coluna própria), a **taxa Shopee** (`commission_fee`), o **líquido/repasse** (`escrow_amount` — confirmado no diagnóstico: buyer 53,70 → comissão 8,95 → líquido 43,76), a forma de pagamento e o **status de entrega** (`logistics_status`). KPIs bruto/taxa/líquido, gráfico e tabela com filtro loja/período. Backend `/api/shopee/financeiro`. Dados de `get_escrow_detail` + `get_tracking_info`, gravados pelo worker no bloco `SHOPEE_SHIPPABLE` (ver `workers.md`) e `shopeeClient.getEscrowDetail`/`getTrackingInfo`. Backfill dos pedidos antigos: `server/backfill-shopee-financeiro.js`.

**Chat** (`sellerchat/get_conversation_list`) — ainda não implementado: o diagnóstico (`test-shopee-apis.js`) deu `param_error` (491), então falta acertar os parâmetros da API de chat antes de codar. Escrow e entrega vieram 200 e estão prontos.

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
- Job **`syncShopeeChat`** (`marketplaceEventWorker`, a cada 10min, isolado do ML): busca conversas não lidas, grava em `shopee_chat` (dedup por `notified_message_id`) e notifica no **Telegram** (`tg_mensagens`) as novas — **com guard de 24h** (`last_message_timestamp` em nanossegundos; conversa antiga é marcada como notificada sem mandar Telegram, pra não spammar no 1º run).
- Página **Mensagens** (`pages/shopee-chat.html`, `SHOPEE_NAV_ITEMS` + allowlist `shopee-demo`): KPIs + lista de conversas pendentes. Backend `/api/shopee/chat`. Responder é feito pelo app da Shopee (fase 1 só notifica/lista).
- Tabela `shopee_chat` (v37) — ver `database.md`.
