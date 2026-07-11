# Integração — Shopee

> Status atual: **não implementada.** Não existe nenhum código relacionado a Shopee no repositório hoje (nenhuma rota, worker, tabela ou cliente HTTP). Este arquivo documenta o gap e como uma futura integração deve se encaixar na arquitetura existente — ver prioridade em `roadmap.md`.

## O que já existe hoje que é Shopee-ready

Nada específico. O nome do projeto ("mercadolivre-souza") e todo o schema (`stores`, `orders`, `items`, etc. — ver `database.md`) são modelados 1:1 em torno da API do Mercado Livre, sem coluna de "marketplace"/"canal" em nenhuma tabela.

## Como uma integração deveria ser adicionada (seguindo o padrão EDA do projeto)

Se/quando a Shopee for integrada, ela deve seguir exatamente o mesmo pipeline documentado em `architecture.md`, não um caminho paralelo:

1. **Cliente HTTP dedicado** — `server/src/shopeeClient.js`, análogo a `mlClient.js`, usado só pelo worker (nunca por rotas de leitura).
2. **OAuth próprio** — a Shopee usa um fluxo de assinatura HMAC diferente do OAuth do ML; não reaproveitar `routes/auth.js` diretamente, criar `routes/authShopee.js` ou generalizar `stores` para um discriminador de marketplace.
3. **Gateway de webhook** — `POST /webhooks/shopee`, mesmo contrato de resposta imediata (200) + enfileiramento que `webhookGateway.js` usa para o ML.
4. **Filas dedicadas** — `shopee-webhooks-{shopId}`, seguindo o padrão de isolamento por loja/canal de `workers.md` (rate limits são por plataforma e por loja, não devem competer com as filas do ML).
5. **Schema** — decisão em aberto: reusar `orders`/`items` com uma coluna `marketplace` (`'ml' | 'shopee'`), ou tabelas paralelas (`shopee_orders`, `shopee_items`). Qualquer uma das duas precisa ser decidida e registrada em `decisions.md` **antes** de implementar, porque afeta todas as queries agregadas hoje escritas assumindo uma única origem (`api.md`: `/dashboard/kpis`, `/comparativos/*`, etc.).
6. **Frontend** — `js/db.js` ganharia métodos novos, mas o contrato "frontend só fala com `/api/*`" (regra 1 de `architecture.md`) não muda.

## O que NÃO fazer

Não adicionar um cliente Shopee direto no frontend (violaria a regra de arquitetura), e não misturar credenciais/tokens Shopee na tabela `stores` sem antes decidir o discriminador de marketplace (item 5 acima) — isso quebraria silenciosamente todo agrupamento por `store_id` que hoje assume "1 store_id = 1 conta ML".
