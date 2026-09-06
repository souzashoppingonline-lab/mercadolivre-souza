# Integração — TikTok Shop

> Status atual (06/09/2026): **Fase 1 (só vendas) construída, ainda não em produção.** Objetivo do usuário: "saber as vendas" — não é réplica da Shopee (chat/catálogo/promoções/financeiro ficam de fora por decisão explícita, ver "O que NÃO foi feito nesta fase"). Código segue o mesmo molde da Shopee (cliente + polling + webhook + rotas + worker), mas **nenhuma chamada real foi testada ainda** — o usuário não tem app criado no Partner Center. Ao tentar o cadastro de "Seller Developer" (autoatendimento, cria app pra própria loja), o TikTok recusou: "só vendedores com Account Manager (AM) atribuído podem se registrar". Ver "Bloqueio de cadastro" abaixo antes de ir a produção.

## Bloqueio de cadastro (06/09/2026, ainda sem solução confirmada)

O Partner Center tem dois tipos de conta no cadastro:
- **Seller Developer** — o próprio vendedor cria o app pra loja dele. **Bloqueado** para esta conta: exige AM (Account Manager) já atribuído pelo TikTok.
- **Partner/Developer** — cria um app não vinculado a nenhuma loja específica, passa por App Review, depois autoriza pra uma loja qualquer (inclusive a própria) via OAuth normal — **não** parece exigir AM.

Caminhos a tentar (usuário está avaliando):
1. Cadastro como **Partner/Developer** em vez de Seller Developer — app fica em revisão antes de poder pedir escopo de Pedidos em produção, mas não depende de AM.
2. **Conseguir um AM** — link "Aprenda como conseguir um AM" no próprio erro; como a loja já vende de verdade no TikTok Shop Brasil, pode qualificar por volume, mas depende de contato com o suporte do Seller Center, sem prazo garantido.

Nenhum dos dois caminhos muda o código já construído — os dois terminam em App Key/App Secret + OAuth, mesmo contrato que `tiktokClient.js` já implementa.

## O que já existe

- **`server/src/marketplaces/tiktok/tiktokClient.js`** — cliente real: `sign()` (HMAC-SHA256 de request de negócio — DIFERENTE da assinatura de webhook), `getAuthorizationUrl`/`exchangeCodeForToken` (funções app-level, exportadas separadas da classe, mesmo padrão de `shopeeClient.js`), `refreshAccessToken`/`getOrder`/`listRecentOrders` (contrato `MarketplaceClient`, mesmo de `amazonClient.js`/`shopeeClient.js`).
- **`server/src/marketplaces/tiktok/TiktokPollingEventSource.js`** — implementação real do `EventSource`: polling a cada 15 min (`TIKTOK_POLL_INTERVAL_MS`), cursor em `marketplace_sync_state`, renovação proativa de token com CAS (margem de 10 min antes de expirar — mesmo padrão de `decisions.md`).
- **`server/src/routes/tiktokAuth.js`** (montada em `/auth/tiktok`) — fluxo OAuth: `GET /config` (diagnóstico), `GET /login` (redireciona pro TikTok), `GET /callback` (troca `code` por tokens, cria/atualiza a linha em `stores`). Ver `api.md`.
- **`server/src/routes/tiktokWebhook.js`** (montada em `/webhooks/tiktok`) — receptor de push, isolado do gateway ML e do webhook Shopee. Ver seção própria abaixo.
- **`server/src/routes/tiktok.js`** (montada em `/api/tiktok`) — dashboard mínimo: `GET /kpis`, `GET /pedidos`, `GET /status`. Deliberadamente **sem** `/produtos`, `/lojas`, `/chat`, `/financeiro` — fora do escopo da Fase 1.
- **`server/src/marketplaceEventWorker.js`** — ganhou um terceiro `Worker`/fila (`marketplace-events-tiktok`) e handler (`handleTiktokOrderEvent`), paralelo ao da Amazon/Shopee, sem tocar neles. Ver `workers.md`.
- **Migration v94** (`server/src/db/migrate-v94.sql`) — habilita `marketplaces.TIKTOK` (`enabled=true`, `api_type='polling'`), `stores.tiktok_shop_id`/`stores.tiktok_shop_cipher` (índice único parcial no shop_id), tabela `tiktok_order_data`. Ver `database.md`. **Testada contra Postgres real** (cadeia completa `schema.sql` → `migrate-v94.sql`, 91 migrations, 0 erro; reexecução confirmada idempotente; queries das 3 rotas de dashboard simuladas com dados sintéticos e conferidas).
- `env.tiktok` em `config/env.js` (`appKey`, `appSecret`, `redirectUri`, `webhookVerify`).
- **`pages/dashboard-tiktok.html`** + **`js/layout-tiktok.js`** — dashboard próprio (KPIs vendas/pedidos hoje e total + tabela de últimos pedidos + card de status da integração), sidebar/topbar isolados (cor de marca `#ff0050`, ícone `fa-tiktok`). Sem tela de produtos/catálogo (Fase 1). Métodos em `js/db.js`: `getTiktokKpis()`, `getTiktokPedidos()`, `getTiktokStatus()`.
- Links cruzados no `mkt-switcher-compact` (ML/Amazon/Shopee/TikTok Shop) adicionados nos 4 layouts (`js/layout.js`, `layout-amazon.js`, `layout-shopee.js`, `layout-tiktok.js`).

## Terminologia e endpoints — confirmados via SDK de referência (06/09/2026)

`partner.tiktokshop.com`/`developers.tiktok-shops.com`/`open-api.tiktokglobalshop.com` estão bloqueados pelo proxy de saída deste ambiente — não dá pra ler a doc oficial nem testar a API viva daqui. Em vez de só busca web (menos confiável), os pontos abaixo foram confirmados lendo o **código-fonte real** do SDK `ecomphp/tiktokshop-php` (pacote Composer ativo, não arquivado, implementa API 202309+ — `github.com/EcomPHP/tiktokshop-php`, clonado e inspecionado por completo). Onde o SDK só expõe a *chamada* e não o *shape da resposta*, isso segue listado em "O que falta confirmar".

- OAuth usa **App Key/App Secret** (não Client ID/Secret) e `grant_type=authorized_code` (grafia não-padrão, propositalmente diferente de `authorization_code` — não "corrigir").
- **URL de autorização**: `https://auth.tiktok-shops.com/oauth/authorize?app_key=&state=` — **SEM `redirect_uri`** como parâmetro (correção: a 1ª versão do código aqui usava `services.tiktokshop.com/open/authorize?service_id=&redirect_uri=`, que não existe no SDK real). O retorno da autorização vai sempre pra "Redirect callback URL" cadastrada no próprio app do Partner Center — nunca passada em runtime. `state` é um valor aleatório de CSRF (o SDK não valida de volta por padrão; este projeto também não valida, mesmo nível de segurança já aceito pra Shopee).
- Troca de código: `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key=&app_secret=&auth_code=&grant_type=authorized_code`. **Resposta NÃO traz `shop_id`/`shop_cipher`** — só `{access_token, refresh_token, access_token_expire_in}`.
- **Descobrir a loja autorizada** (passo que faltava): depois do token/get, chamar `GET authorization/{version}/shops` (autenticado com o access_token recém-emitido, SEM `shop_cipher` na assinatura — esse endpoint é chamado antes de a conta ter um) — `TiktokClient.getAuthorizedShops()`. É daqui que vem `shop_id`/`shop_cipher` pra gravar em `stores`.
- Refresh: `GET https://auth.tiktok-shops.com/api/v2/token/refresh?...&grant_type=refresh_token`. Expiração padrão do access_token ~7 dias.
- Shop API: base `https://open-api.tiktokglobalshop.com`, path no formato `{categoria}/{version}/{ação}` (ex.: `order/202309/orders/search`, `authorization/202309/shops`, `event/202309/webhooks`).
- Assinatura de **request de negócio** (Shop API) — CONFIRMADA passo a passo contra `Client::prepareSignature` do SDK: `sign = HMAC-SHA256(app_secret, app_secret + path + query_ordenada(sem sign/access_token) + body + app_secret)`, hex minúsculo, no parâmetro `sign` da query string — **diferente** da assinatura de webhook. `shop_cipher` só entra na assinatura quando a conta já tem um (fica de fora nas rotas `/authorization/...`, confirmado no SDK).
- Assinatura de **webhook** — CONFIRMADA (também bate com `Webhook::verify` do SDK): `HMAC-SHA256(app_secret, app_key + raw_body)`, hex minúsculo, no header `Authorization` **sem** prefixo "Bearer". Sem timestamp — sem proteção a replay.
- **`type` do webhook é um CÓDIGO NUMÉRICO**, não string (correção: a doc pública sugeria algo como `"ORDER_STATUS_CHANGE"`, mas o SDK usa constantes inteiras): `1`=ORDER_STATUS_UPDATE (o único tratado nesta fase), `2`=REVERSE_ORDER_STATUS_UPDATE, `3`=RECIPIENT_ADDRESS_UPDATE, `4`=PACKAGE_UPDATE, `5`=PRODUCT_STATUS_UPDATE, `6`=SELLER_DEAUTHORIZATION, `7`=UPCOMING_AUTHORIZATION_EXPIRATION, `12`=RETURN_STATUS_UPDATE. Payload: `{type, shop_id, data, timestamp}` (o `tts_notification_id` usado no dedupe do BullMQ segue não confirmado — se não vier no payload real, o dedupe cai pra `storeId+orderId`, que já é o `jobId` usado).
- Busca de pedidos: `POST order/202309/orders/search` — `page_size`/`sort_order`/`page_token`/`sort_field` vão na **query**, o resto do filtro (ex. `update_time_ge`) no **body** JSON (confirmado: `Resource::extractParams` do SDK faz exatamente esse split).
- Detalhe de pedido: `GET order/202309/orders?ids=id1,id2,...` (**correção**: não existe `orders/{id}` como path param — é sempre o endpoint plural com `ids` na query, mesmo pra 1 pedido só).
- `order_status` é um enum de STRING confirmado (classe `Order` do SDK): `UNPAID`, `AWAITING_SHIPMENT`, `AWAITING_COLLECTION`, `PARTIALLY_SHIPPING`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED` — bate exatamente com `mapTiktokStatus()` em `marketplaceEventWorker.js`.
- Gestão de webhook: `GET event/202309/webhooks` (lista), `PUT event/202309/webhooks` `{address, event_type}` (registra/atualiza — **correção**: não é `POST`), `DELETE event/202309/webhooks` `{event_type}` (remove). `event_type` usa os mesmos códigos numéricos acima.
- Erro de negócio: resposta HTTP 200 com `{code, message, data}`; `code=0` é sucesso. Token/auth inválido quando os 3 primeiros dígitos do `code` são `105` ou `360` (grupo de erro, confirmado no SDK — mais robusto que uma lista fixa).

## O que falta confirmar

Itens abaixo estão marcados com `⚠️` no código (`tiktokClient.js`, `tiktokAuth.js`) — **não inventar valores além do documentado**, mesma disciplina já usada pra Shopee (ver "O que NÃO fazer"). Diferente da rodada anterior, o SDK de referência não deixou muita coisa em aberto — sobrou principalmente o *shape* de respostas, que nenhum SDK de terceiros costuma documentar:

1. **Nomes exatos dos campos dentro da resposta de pedido** (`order/202309/orders` e `orders/search`) — `getOrder()`/`listRecentOrders()` tentam `order_list`/`orders` como chave da lista e `order_id`/`order_status`/`payment.total_amount`/`create_time` dentro de cada item (prováveis pelo padrão do resto da API), mas nenhum SDK inspecionado expõe o JSON de resposta real.
2. **Nomes exatos dos campos dentro de `authorization/202309/shops`** — `getAuthorizedShops()` tenta `shop_id`/`id` e `shop_cipher`/`cipher`; o SDK só mostra a chamada (`Authorization->getAuthorizedShop()`), não a resposta.
3. **Se `tts_notification_id` existe de fato no payload do webhook** — não confirmado no SDK (que só lê `type`/`shop_id`/`data`/`timestamp`); não é bloqueante porque o dedupe já usa `storeId+orderId` como `jobId`.

Cada um só pode ser fechado com o app criado e uma primeira chamada real — não há como testar contra a API viva a partir deste ambiente (proxy de saída bloqueia os domínios do TikTok Shop) nem sem credenciais do usuário.

## Webhook — implementado, sem handshake

Receptor **isolado** de tudo o mais: `server/src/routes/tiktokWebhook.js`, montado em **`/webhooks/tiktok`**, **antes** do `express.json()` global (`express.raw()` — a assinatura precisa do corpo cru). Fluxo: responde `200` na hora → valida assinatura (`Authorization` header, sem prefixo) → filtra `type=1` (ORDER_STATUS_UPDATE, ver seção de terminologia — outros tipos são ignorados de propósito) → enfileira o **mesmo evento padronizado do polling** (`marketplace-events-tiktok`, `jobId` `TIKTOK:ORDER_UPDATED:{storeId}-{orderId}`) → `handleTiktokOrderEvent` processa igual, em tempo real. A doc pública do TikTok não descreve um passo de handshake/echo ao cadastrar a URL (diferente da Shopee) — só um `GET` de teste de conectividade (implementado, responde 200). Se o console do TikTok exigir um handshake real na hora de cadastrar, isso vai aparecer no 1º teste e precisa ser adicionado.

- **Configuração** (usuário, quando o app existir): `PUT event/202309/webhooks` com `{address: 'https://multimixvendas.duckdns.org/webhooks/tiktok', event_type: 1}` — não há tela de "colar URL" confirmada no Partner Center pra Custom App; pode ser preciso chamar esse endpoint programaticamente (script pontual, mesmo padrão de `server/scripts/verificarPromocaoItem.js` da Analista Ecom) em vez de cadastrar pela UI.
- **Escape hatch**: `TIKTOK_WEBHOOK_VERIFY=false` desliga a validação de assinatura pro 1º teste (mesmo padrão `SHOPEE_WEBHOOK_VERIFY`).
- **Dedup com o polling**: mesmo `jobId` → BullMQ ignora duplicata. Polling continua ligado como rede de segurança (mesma decisão da Shopee — webhooks podem se perder).

## Dashboard dedicado (`pages/dashboard-tiktok.html`)

KPIs (vendas/pedidos hoje e total), tabela de últimos 200 pedidos, card de status (última sincronização, contas conectadas). Sem produtos/catálogo — Fase 1 é só vendas. Ver `frontend.md` pro contrato geral de página nova.

**Estado atual da página: "em construção"** (classe `.em-construcao` de `css/style.css`, mesmo padrão já usado nos módulos ainda não implementados). Enquanto não existe conta TikTok Shop autorizada (sem app no Partner Center, ver "Bloqueio de cadastro"), mostrar KPIs zerados seria enganoso — a página avisa que a integração está pronta no backend mas falta autorizar a conta. Todo o HTML/JS de KPIs/tabela/status (o dashboard real) continua no arquivo, **comentado** (bloco HTML dentro de `<!-- -->` + os `<script>` de `db.js`/`tableExport.js`/`websocket.js` e a lógica de `loadKpis`/`loadPedidos`/`loadStatus`) — descomentar os dois blocos juntos assim que `/auth/tiktok/login` autorizar a 1ª conta real.

## O que NÃO foi feito nesta fase (por decisão explícita do usuário — "saber as vendas")

Ao contrário da Shopee (que cresceu de "só pedidos" até chat/catálogo/promoções/financeiro/score/precificador ao longo de várias fases), o TikTok Shop **fica só em vendas** por enquanto:
- Sem catálogo de produtos (Product API) — sem tela de anúncios/estoque/preço.
- Sem chat (Message API).
- Sem promoções/cupons.
- Sem financeiro/repasse (Finance API) — nenhuma tela de conciliação.
- Sem devoluções (Returns API).
- Sem papel de login restrito equivalente ao `shopee-demo` — não há revisor externo do TikTok pra atender ainda.

Se o usuário pedir qualquer um desses depois, seguir o mesmo padrão incremental já usado na Shopee (uma fase de cada vez, com o contrato de campo confirmado antes de codificar).

## Páginas públicas de política (exigidas pelo cadastro do app)

O Partner Center pede, no "Questionário sobre segurança e privacidade de dados" (abas Segurança / Privacidade e conformidade / Comentários), um **link** + uma **imagem de evidência** por pergunta (ex.: "Sua organização tem uma política de segurança publicada?"). As páginas ficam no domínio de produção:

- `https://multimixvendas.duckdns.org/politica-de-privacidade` (`politica-de-privacidade.html`)
- `https://multimixvendas.duckdns.org/politica-seguranca` (`politica-seguranca.html`)

Ambas são páginas públicas autocontidas (sem depender de `css/js` do sistema nem de login) — ver `.claude/backend.md`. **Antes de submeter ao TikTok**, o usuário precisa preencher os campos marcados `[PREENCHER: ...]` nelas (razão social/CNPJ, e-mail de contato, e a seção de infraestrutura de rede da política de segurança — só com controles realmente implementados, nunca declarar algo que não existe).

O **link** de cada pergunta do questionário aponta pra uma dessas páginas (a mais próxima do assunto perguntado). A **imagem de evidência** é responsabilidade do usuário — evidências de infraestrutura real (firewall, monitoramento, etc.) não podem ser fabricadas; uma captura de tela da própria página publicada serve como evidência de "política publicada", mas não substitui evidência de controles de infraestrutura que só o usuário pode capturar.

## O que NÃO fazer

- Não adicionar um cliente TikTok direto no frontend — toda leitura passa por `/api/tiktok/*` (mesma regra de `architecture.md`).
- Não "adivinhar" nomes de campo/endpoint além do que está na seção "Terminologia e endpoints confirmados" — usar os itens de "O que falta confirmar" como checklist antes de confiar em qualquer dado do TikTok em produção.
- Nunca colar `App Secret`/tokens em chat — só em `server/.env`.
- Não tentar registrar como "Seller Developer" de novo sem primeiro tentar "Partner/Developer" ou conseguir um AM — ver "Bloqueio de cadastro".
