# Integração — Shopee

> Status atual (v18, 14/07/2026): **implementação real da fase 1 concluída — autenticação (assinatura HMAC + OAuth completo) e sincronização de pedidos via polling.** Credenciais (`SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY`) já estão em `server/.env`, ambiente **sandbox** (não produção — a Shopee avisa que sandbox "é funcional mas não replica 100% o comportamento de produção"). `shopeeClient.js` deixou de ser stub. Falta o usuário autorizar de fato uma loja de teste via `/auth/shopee/login` para o pipeline começar a processar pedidos reais de sandbox — ver "Como testar" abaixo. Ver a decisão de arquitetura completa em `decisions.md` ("Shopee sai do stub").

## O que já existe

- **`server/src/marketplaces/shopee/shopeeClient.js`** — cliente real: `SignatureBuilder` (HMAC-SHA256, base string partner-level vs. shop-level), `getAuthorizationUrl`/`exchangeCodeForToken` (funções partner-level, exportadas separadas da classe porque rodam antes de qualquer loja autorizada), `refreshAccessToken`/`getOrder`/`listRecentOrders` (contrato `MarketplaceClient`, mesmo de `amazonClient.js`).
- **`server/src/marketplaces/shopee/ShopeePollingEventSource.js`** — implementação real do `EventSource`, mesmo molde de `AmazonPollingEventSource.js`: polling a cada 15 min, cursor em `marketplace_sync_state`, renovação proativa de token com CAS (ver `decisions.md`).
- **`server/src/routes/shopeeAuth.js`** (montada em `/auth/shopee`) — fluxo OAuth completo: `GET /config` (diagnóstico), `GET /login` (redireciona pra Shopee), `GET /callback` (troca `code` por tokens, cria/atualiza a linha em `stores`). Ver `api.md`.
- **`server/src/marketplaceEventWorker.js`** — ganhou um segundo `Worker`/fila (`marketplace-events-shopee`) e handler (`handleShopeeOrderEvent`), paralelo ao da Amazon, sem tocar nele. Ver `workers.md`.
- **Migration v18** (`server/src/db/migrate-v18.sql`, espelhada em `schema.sql`) — habilita `marketplaces.SHOPEE` (`enabled=true`, `api_type='polling'`), `stores.shopee_shop_id` (índice único parcial), tabela `shopee_order_data`. Ver `database.md`.
- `env.shopee` em `config/env.js` (`partnerId`, `partnerKey`, `redirectUri`, `env`).

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

## Webhook ("Mecanismo de Empurra") — fase 2, não implementado ainda

A Shopee expõe push de pedido de verdade (confirmado pela KB de referência do usuário e pela existência da seção "Mecanismo de Empurra" no console) — diferente do que a versão anterior deste arquivo especulava. A fase 1 usa **polling mesmo assim** (mesma decisão que a Amazon tomou no início: validar autenticação/formato de chamada sem depender de um endpoint de webhook público testado). Antes de migrar para push:

1. Confirmar no console se "Mecanismo de Empurra" pede uma `push_url` e qual o formato exato de assinatura do payload (a Shopee costuma assinar `url + "|" + body` com a mesma `partner_key`, mas **não deve ser assumido sem checar** — validar contra o portal do parceiro).
2. Implementar o receptor seguindo o mesmo padrão do Gateway ML (`webhookGateway.js`): responder `200` imediato, validar assinatura, enfileirar, processar assíncrono.
3. Manter o polling como rede de segurança mesmo depois de ligar o webhook (webhooks podem falhar/se perder) — não desligar `ShopeePollingEventSource`, só reduzir a frequência se fizer sentido.

## O que NÃO fazer

- Não adicionar um cliente Shopee direto no frontend (violaria a regra de arquitetura — toda leitura passa por `/api/*`).
- Não tentar "adivinhar" nomes de campo/endpoint que não estão confirmados — a Shopee muda contrato entre versões menores; qualquer endpoint novo (produto, logística, financeiro — ainda não implementados) deve ter o campo/nome confirmado no portal do parceiro antes de codificar.
- Não criar uma rota admin manual pra colar `refresh_token` de Shopee (como existe hoje pra Amazon) — a Shopee sempre exige o fluxo OAuth completo pra emitir token; não existe "gerar refresh token" fora dele (ver `decisions.md`).
- Nunca colar `Partner Key`/tokens em chat — só em `server/.env`.
