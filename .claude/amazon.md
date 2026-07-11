# Integração — Amazon

> Status atual: **em construção, desconectada do sistema em produção.** App já criado (`FinanceEcom`) e credenciais parciais recebidas — falta configurar `server/.env` com os valores restantes e confirmar a decisão de schema antes de ligar ao worker/rotas. Ver `.claude/decisions.md` (Marketplace Engine) e `.claude/roadmap.md`.

## O que já existe

- `server/src/marketplaces/interfaces/MarketplaceClient.js` — contrato comum que todo adapter de marketplace implementa (`refreshAccessToken`, `getOrder`, `listRecentOrders`).
- `server/src/marketplaces/base/errors.js` — `MarketplaceRateLimitError`, `MarketplaceTokenInvalidError`, `MarketplaceTransientError`, compartilhadas entre adapters novos.
- `server/src/marketplaces/amazon/amazonClient.js` — implementação real: troca de `AMAZON_REFRESH_TOKEN` por access token via LWA (`https://api.amazon.com/auth/o2/token`), chamadas à SP-API (`getOrder`, `listRecentOrders`) usando o header `x-amz-access-token`. **Não é chamado por nenhuma rota/worker ainda** — só existe isolado.
- `config/env.js` ganhou o namespace `amazon` (`appId`, `lwaClientId`, `lwaClientSecret`, `refreshToken`, `marketplaceId`, `region`), lido de `server/.env` (nunca hardcoded).
- `server/.env.example` documenta as variáveis novas (`AMAZON_*`), sem valores reais.

## Credenciais — o que já temos e o que falta

| Credencial | Status |
|---|---|
| Nome do app (`FinanceEcom`) | ✅ recebido |
| `AMAZON_APP_ID` (`amzn1.sp.solution...`) | ✅ recebido — **atenção**: este é o Application ID do Developer Console, **não** é o mesmo valor que `AMAZON_LWA_CLIENT_ID` |
| `AMAZON_REFRESH_TOKEN` (prefixo `Atzr\|`) | ✅ recebido — nunca commitado no repositório, só em `server/.env` (protegido pelo `.gitignore`) |
| `AMAZON_LWA_CLIENT_ID` | ❌ faltando — necessário para trocar o refresh token por access token |
| `AMAZON_LWA_CLIENT_SECRET` | ❌ faltando — idem |
| `AMAZON_MARKETPLACE_ID` (Brasil = `A2Q3Y263D00KWC`) | ❌ faltando |
| `AMAZON_REGION` | assumido `na` (Brasil fica na região NA da SP-API — `sellingpartnerapi-na.amazon.com`) — confirmar |

Sem `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET` o `amazonClient.js` não autentica de verdade — ele já lança `MarketplaceTokenInvalidError` explicando quais variáveis faltam se chamado sem configuração completa.

## O que ainda falta para ligar ao sistema em produção

1. Confirmar a decisão de schema (coluna `marketplace` discriminadora vs. tabelas paralelas — proposta em `decisions.md`, pendente de confirmação).
2. Migration correspondente (`database.md`).
3. Um worker/fila dedicado (`amazon-orders-{...}`) que chama `AmazonClient.listRecentOrders`/`getOrder` — a Amazon não tem um webhook "topic+resource" simples como o ML; usa *Notifications API* (SQS/EventBridge) ou polling periódico. Para o primeiro corte, polling periódico (como `syncVendas` do ML) é mais simples de implementar corretamente do que assinar Notifications API — decisão a registrar quando essa etapa começar.
4. Rota REST espelhando o que já existe para ML (`api.md`) — ou, se a decisão de schema for "coluna discriminadora", os endpoints existentes passam a incluir Amazon automaticamente sem rota nova.

## Particularidades da Amazon a considerar

A Amazon Selling Partner API (SP-API) difere do modelo do Mercado Livre em pontos que afetam diretamente decisões já tomadas neste projeto:

- **Autenticação**: LWA (Login with Amazon) para o access token — implementado em `amazonClient.js`. AWS Signature v4 (IAM) só é exigida hoje pela Amazon para *restricted operations* (dados pessoais de comprador); a Orders API sem PII funciona só com o bearer token da LWA, por isso o cliente atual não implementa SigV4 ainda — se no futuro precisarmos de PII do comprador, isso vira um item novo aqui.
- **Notificações**: a Amazon usa *Notifications API* (SNS/SQS) em vez de webhook HTTP simples "topic+resource" como o ML. Por isso o primeiro corte planejado é **polling periódico** (equivalente ao `syncVendas` do ML), não um gateway de webhook — mais simples e correto para um volume inicial baixo. Assinar a Notifications API fica como evolução futura se o polling não escalar.
- **Rate limits**: a SP-API usa *token bucket* por operação (não por app como o ML) — cada endpoint (`getOrders`, `getOrder`, etc.) tem seu próprio limite documentado pela Amazon. O `amazonClient.js` atual não implementa esse controle ainda (só trata 429 lançando `MarketplaceRateLimitError`); um limiter por operação é trabalho para quando o polling for de fato ligado.

## O que NÃO fazer

Não adicionar chamadas à SP-API no frontend nem em rotas de leitura de `routes/api.js` — mesma regra de fronteira que vale para o Mercado Livre (`architecture.md`, regra 1–3). Não modificar `mlClient.js`/`routes/auth.js` para "generalizar" para Amazon — o ML fica intocado (ver `decisions.md`).
