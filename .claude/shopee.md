# Integração — Shopee

> Status atual (13/07/2026): **perfil de desenvolvedor aprovado pela Shopee Open Platform, ambiente sandbox liberado.** Ainda não é produção — sandbox "é funcional mas não replica 100% o comportamento de produção" (aviso da própria Shopee no e-mail de aprovação). Ainda sem `Partner ID`/`Partner Key` de um app criado (em andamento). Existe hoje um **stub** (`server/src/marketplaces/shopee/shopeeClient.js`) que só documenta o contrato e lança erro explicando o bloqueio — não é uma implementação funcional ainda. Ver prioridade em `roadmap.md` e a decisão de arquitetura "Marketplace Engine" em `decisions.md`.

## O que já existe

- `server/src/marketplaces/shopee/shopeeClient.js` — implementa `MarketplaceClient` (`interfaces/MarketplaceClient.js`) lançando erro em todo método, com a mensagem apontando para este arquivo. Existe só para o resto do código já poder referenciar `'shopee'` como marketplace sem quebrar, e para não perder o contrato quando a implementação real começar.
- Nenhuma rota, fila, worker ou coluna de banco específica de Shopee — nada disso deve ser criado antes de haver credenciais reais (mesmo que de sandbox) pra testar contra a API de verdade (evita código morto/especulativo, ver `workflow.md`: "nunca aceite... arquivos desnecessários").

## Infraestrutura já confirmada para o cadastro do app na Shopee

- **IP de saída do servidor de produção** (exigido pela Shopee em "Acesso a Dados Sensíveis → Lista de IPs Permitidos", obrigatório pra todo app — diferente do ML, que não tem esse requisito): `207.180.194.61`, confirmado **fixo** pelo usuário (`curl -4 ifconfig.me` no servidor). Precisa ser cadastrado manualmente no console da Shopee Open Platform antes de qualquer chamada envolvendo dado sensível funcionar.
- **Domínio de redirect (OAuth sandbox)**: mesmo domínio já usado pelo Mercado Livre — `https://multimixvendas.duckdns.org`. O ML usa `/auth/callback`; a Shopee deve usar um path próprio (ex: `/auth/shopee/callback`) quando o fluxo de autorização for implementado — a rota ainda não existe, só o domínio está reservado/decidido.
- Domínio é DuckDNS (DNS dinâmico) — o IP por trás foi confirmado fixo pelo usuário, então não deve mudar sozinho, mas vale reconfirmar com o provedor da VPS se algo parar de funcionar de repente.

## Pré-requisitos antes de sair do stub

1. Finalizar a criação do app no console Shopee Open Platform (sandbox) e obter `Partner ID`/`Partner Key` — **nunca colar esses valores em chat**, só em `server/.env`.
2. Confirmar se a Shopee Open Platform expõe push/webhook de pedidos — o console tem uma seção **"Mecanismo de Empurra"** separada da configuração de OAuth, que sugere que sim; precisa confirmar se ela pede uma URL de callback antes de decidir entre o padrão webhook do ML (`/webhooks/shopee`, gateway → fila → worker) ou o padrão polling da Amazon (`ShopeePollingEventSource`, mesmo molde de `amazon/AmazonPollingEventSource.js`).
3. A decisão de schema já tomada para múltiplos marketplaces (coluna `marketplace_id` discriminadora — ver `decisions.md`) já cobre a Shopee; não é necessário decidir de novo quando a implementação começar, só seguir o padrão.

## Como a implementação real deve seguir o padrão já estabelecido (Amazon como referência)

Quando o app for criado e as credenciais (`Partner ID`/`Partner Key`) chegarem, `shopeeClient.js` deixa de ser stub e passa a implementar de verdade `refreshAccessToken`/`getOrder`/`listRecentOrders` (mesmo contrato usado por `amazon/amazonClient.js`), lendo credenciais só de `server/.env` (nunca hardcoded), sem tocar em `mlClient.js`/`routes/auth.js`.

**Múltiplas contas desde o início**: a Amazon (v16, ver `amazon.md`/`decisions.md`) já estabeleceu o padrão de suportar várias contas por marketplace — uma linha em `stores` por conta (com `marketplace_id=SHOPEE`), credenciais mescladas por conta com fallback pro `.env` global, uma `EventSource` por conta registrada no `Scheduler`, e o campo `storeId` no evento padronizado como chave de roteamento. A implementação real da Shopee deve seguir esse mesmo padrão desde o primeiro commit — não implementar "conta única fixa" e refatorar depois.

## O que NÃO fazer

Não adicionar um cliente Shopee direto no frontend (violaria a regra de arquitetura), não tentar implementar chamadas reais antes de ter `Partner ID`/`Partner Key` de verdade (não há como testar, e assinatura HMAC errada rejeitada silenciosamente é difícil de depurar às cegas), e não criar tabelas/colunas específicas de Shopee antecipadamente — a coluna `marketplace_id` genérica já decidida em `decisions.md` cobre o caso quando chegar a hora.
