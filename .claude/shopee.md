# Integração — Shopee

> Status atual: **bloqueada — app em análise/aprovação pela Shopee.** Sem `client_id`/`client_secret` da Shopee, nenhuma chamada real é possível. Existe hoje um **stub** (`server/src/marketplaces/shopee/shopeeClient.js`) que só documenta o contrato e lança erro explicando o bloqueio — não é uma implementação funcional. Ver prioridade em `roadmap.md` e a decisão de arquitetura "Marketplace Engine" em `decisions.md`.

## O que já existe

- `server/src/marketplaces/shopee/shopeeClient.js` — implementa `MarketplaceClient` (`interfaces/MarketplaceClient.js`) lançando erro em todo método, com a mensagem apontando para este arquivo. Existe só para o resto do código já poder referenciar `'shopee'` como marketplace sem quebrar, e para não perder o contrato quando a implementação real começar.
- Nenhuma rota, fila, worker ou coluna de banco específica de Shopee — nada disso deve ser criado antes do app ser aprovado e as credenciais chegarem (evita código morto/especulativo, ver `workflow.md`: "nunca aceite... arquivos desnecessários").

## Pré-requisitos antes de sair do stub

1. App aprovado pela Shopee com `Partner ID`/`Partner Key` (Shopee usa assinatura HMAC-SHA256 por requisição, não OAuth Authorization Code como o ML).
2. Confirmar se a Shopee Open Platform expõe push/webhook de pedidos (ela tem, mas com formato próprio) ou se o primeiro corte também será por polling, como decidido para a Amazon (`amazon.md`).
3. A decisão de schema já tomada para múltiplos marketplaces (coluna `marketplace` discriminadora — ver `decisions.md`) já cobre a Shopee; não é necessário decidir de novo quando a implementação começar, só seguir o padrão.

## Como a implementação real deve seguir o padrão já estabelecido (Amazon como referência)

Quando o app for aprovado, `shopeeClient.js` deixa de ser stub e passa a implementar de verdade `refreshAccessToken`/`getOrder`/`listRecentOrders` (mesmo contrato usado por `amazon/amazonClient.js`), lendo credenciais só de `server/.env` (nunca hardcoded), sem tocar em `mlClient.js`/`routes/auth.js`.

**Múltiplas contas desde o início**: a Amazon (v16, ver `amazon.md`/`decisions.md`) já estabeleceu o padrão de suportar várias contas por marketplace — uma linha em `stores` por conta (com `marketplace_id=SHOPEE`), credenciais mescladas por conta com fallback pro `.env` global, uma `EventSource` por conta registrada no `Scheduler`, e o campo `storeId` no evento padronizado como chave de roteamento. A implementação real da Shopee deve seguir esse mesmo padrão desde o primeiro commit — não implementar "conta única fixa" e refatorar depois.

## O que NÃO fazer

Não adicionar um cliente Shopee direto no frontend (violaria a regra de arquitetura), não tentar implementar chamadas reais antes do app ser aprovado (não há como testar, e assinatura HMAC errada rejeitada silenciosamente é difícil de depurar às cegas), e não criar tabelas/colunas específicas de Shopee antecipadamente — a coluna `marketplace` genérica já decidida em `decisions.md` cobre o caso quando chegar a hora.
