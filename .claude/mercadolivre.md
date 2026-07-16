# Integração — Mercado Livre

> Escopo: como o sistema se autentica e conversa com a API do Mercado Livre — OAuth, cliente HTTP, webhooks recebidos. Para o que cada webhook faz no banco, ver `workers.md`. Para os endpoints REST expostos ao frontend, ver `api.md`. Esta é a única integração de marketplace implementada hoje — para o status de Shopee/Amazon ver `shopee.md`/`amazon.md`.

## OAuth — `server/src/routes/auth.js`

Fluxo Authorization Code padrão do ML:

1. `GET /auth/login[?store_id=X]` → redireciona para `https://auth.mercadolivre.com.br/authorization` com `client_id`/`redirect_uri` (padrão do `.env`, ou os próprios `stores.ml_client_id`/`ml_client_secret` se `store_id` foi passado e a loja tiver credenciais cadastradas via `PATCH /api/lojas/:id/credentials`).
2. `GET /auth/callback` (alias `GET /ml/callback`, ambos registrados porque o app ML tem `/ml/callback` cadastrado como redirect URI em produção) → troca `code` por tokens em `POST /oauth/token`, busca `GET /users/:user_id`, faz upsert em `stores` (chave primária = `user_id` do ML).
3. Token renovado automaticamente pelo worker antes de expirar — nunca pelo usuário manualmente, exceto reconexão completa via `/auth/login` quando o refresh token é invalidado.

### `refreshToken(storeId)` — exportado por `auth.js`, usado por `mlClient.js` e pelos syncs do worker

- Usa `stores.ml_client_id`/`ml_client_secret` se presentes, senão as credenciais globais do `.env`.
- **429 no refresh** → lança `OAUTH_RATE_LIMITED` imediatamente (nunca faz retry recursivo — isso já causou um loop infinito no passado, ver `decisions.md`).
- **400/401** → usa um padrão de *compare-and-swap* (CAS): incrementa `refresh_failures` só se o `refresh_token` lido no início da função ainda for o mesmo salvo no banco (`WHERE refresh_token = $oldRefreshToken`). Se o `rowCount` vier 0, significa que uma reconexão manual (`/auth/login`) já salvou um token novo enquanto essa chamada estava em voo — nesse caso o refresh falho é ignorado e o token novo do banco é retornado. Isso evita que uma corrida entre refresh automático e reconexão manual sobrescreva um token válido com erro.
- Com menos de 3 falhas consecutivas, lança erro `transient` (o worker deixa para a próxima janela). Na 3ª falha consecutiva, invalida definitivamente: `access_token=NULL`, `token_expires_at='1970-01-01'` (o "token epoch zero" citado em `workers.md`) e lança `TOKEN_INVALID`/`err.permanent=true` — a partir daí só reconexão manual resolve.
- **Sucesso** também usa CAS: só grava o novo token se o `refresh_token` no banco não mudou durante a chamada; caso contrário, devolve o token que já foi salvo pela reconexão concorrente.

### `GET /auth/config` — diagnóstico

Mostra `client_id`/`redirect_uri` configurados (nunca o secret) para comparar com o painel `developers.mercadolivre.com.br`. Existe porque o erro mais comum de integração é `redirect_uri` não bater exatamente (http vs https, barra final, porta) — o ML rejeita silenciosamente com "não foi possível conectar".

## Cliente da API — `server/src/mlClient.js`

Uso restrito: só `worker.js` e ações pontuais explícitas de rotas REST (responder pergunta, sync de promoção sob demanda) — nunca para popular listagens do dashboard (regra de arquitetura).

- `getAccessToken(storeId)`: se o token tem ≥5 min de validade, retorna direto; senão dispara `refreshToken`. Usa `refreshLocks` (Map de Promises) para deduplicar refreshes concorrentes do mesmo `storeId` — se dois handlers pedem o token do mesmo lojista ao mesmo tempo, só um POST de refresh é feito.
- `oauthCooldown` (Map storeId → timestamp): após um 429 no refresh, bloqueia novas tentativas de refresh daquela loja por 5 min — **exceto** se o token já expirou de fato (deixa tentar mesmo assim, já que não há nada a perder).
- `get(path, storeId, retries=1)`: 429 → lança na hora (para o backoff do BullMQ assumir, não bloquear o slot do worker com espera interna); 5xx → 1 retry automático após 2s; outros erros não-OK → lança.
- Endpoints usados hoje: `getItem`, `getOrder`, `getPayment` (`/collections/:id`), `getQuestion`, `answerQuestion` (`POST /answers`), `getMessage`, `getMessagesPack`, `getSellerReputation`, `getShipment`, `searchClaims` (`/post-purchase/v1/claims/search`), `getClaim` (`/post-purchase/v1/claims/:id`), `getClaimReason` (`/marketplace/v2/claims/reasons/:id` — traduz `reason_id` pra descrição em português, cacheado em `claim_reasons`, ver `database.md`/`decisions.md`), `getOffer` (`/seller-promotions/offers/:id`), `searchOrders` (`/orders/search`), `getItemVisits` (`/items/:id/visits/time_window`), `getItemDescription` (`/items/:id/description`, campo `.plain_text` usado pra contar palavras — SEO Score, ver `business-rules.md`), `getCategoryAttributes` (`/categories/:id/attributes`, filtrado por `.tags.required` — atributos obrigatórios da categoria, cacheado 30 dias em `category_attributes_cache`, ver `database.md`), `getPriceToWin` (`/items/:id/price_to_win?version=v2` — status de buy-box, preço pra vencer, boosts faltando; Monitor de Buy-Box, ver `business-rules.md`/`decisions.md`), `getCatalogCompetitors` (`/products/:id/items` — lista de concorrentes do mesmo produto de catálogo, chamada só sob demanda, nunca no job diário). Chamadas ad-hoc adicionais (fora dessa lista de atalhos) usam `ml.get(path, storeId)` diretamente — ex.: `/item/:id/performance`, `/items/:id?include_attributes=all`, `/items/:id/promotions`, `/items/:id/deals/:dealId`, `/seller-promotions/users/:id/promotions`.
- **`GET /sites/MLB/search` (busca livre por palavra-chave) está bloqueada pra este app** — confirmado ao vivo: `403 {"message":"forbidden","error":"forbidden"}`, consistente mesmo após 20s de espera (não é rate limit passageiro, sem headers `x-ratelimit-*`). Não tentar de novo sem antes confirmar no painel de desenvolvedores do ML se o escopo foi liberado — ver `decisions.md`.

## Webhooks recebidos — `POST /webhooks/ml`

Payload esperado do ML: `{ topic, resource, user_id, application_id }`. `user_id` é usado como `store_id`. A rota responde `200` **antes** de qualquer processamento (requisito do ML — timeout curto), grava um registro `pending` em `webhook_logs` e enfileira o job (ver `workers.md` para o pipeline completo).

Tópicos que o ML pode enviar e que o sistema trata (mapeamento completo de handlers em `workers.md`): `orders_v2`, `payments`, `questions`, `messages`, `items`, `public_offers`, `post_purchase`, `items_prices`, `shipments`. Recebidos mas ignorados: `invoices`, `public_candidates`, `stock-locations`.

Tópicos recomendados a configurar no painel do app ML (de `server/README.md`): `orders_v2`, `questions`, `messages`, `items`, `payments`.

## Rate limiting da API do ML — como o sistema se protege

- Cada loja tem app ML próprio → rate limit por app, não compartilhado entre lojas (por isso filas/workers separados por `storeId`, ver `workers.md`).
- ML permite ~3000 req/min por app; o worker se autolimita a ~60 req/min por loja (`limiter: 3 req/3s` × `concurrency: 3`) — bem abaixo do limite, para deixar margem para os syncs noturnos e picos de webhook simultâneos.
- 429 em chamadas normais → backoff exponencial do BullMQ (5 tentativas) → cooldown de 5 min por `topic:storeId` se esgotar tentativas.
- 429 no refresh de token (OAuth) → cooldown de 5 min por loja (histórico: já foi 35 min, reduzido — ver `decisions.md`).

## Credenciais por loja

Cada loja pode ter `ml_client_id`/`ml_client_secret` próprios (`stores.ml_client_id/ml_client_secret`, configurável via `PATCH /api/lojas/:id/credentials`). Se ausentes, usa as credenciais globais do `.env` (`ML_CLIENT_ID`/`ML_CLIENT_SECRET`). Isso permite múltiplas lojas com apps ML diferentes (rate limits independentes de verdade) sem precisar de múltiplos `.env`.
