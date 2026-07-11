# Integração — Amazon

> Status atual: **não implementada.** Não existe nenhum código relacionado a Amazon (SP-API ou qualquer outra) no repositório hoje. Este arquivo documenta o gap — ver prioridade em `roadmap.md`.

## O que já existe hoje que é Amazon-ready

Nada específico. Mesma observação de `shopee.md`: o schema inteiro (`database.md`) é modelado em torno da API do Mercado Livre.

## Particularidades da Amazon a considerar quando for implementada

A Amazon Selling Partner API (SP-API) difere do modelo do Mercado Livre em pontos que afetam diretamente decisões já tomadas neste projeto:

- **Autenticação**: SP-API usa AWS Signature v4 + LWA (Login with Amazon) OAuth — não é um Authorization Code simples como o ML. `routes/auth.js` não é reaproveitável como está.
- **Notificações**: a Amazon usa *Notifications API* (SNS/SQS ou destino HTTP) em vez de webhooks HTTP simples "topic+resource" como o ML. O `webhookGateway.js` atual assume payload `{ topic, resource, user_id }` — um gateway Amazon precisaria de um parser de payload completamente diferente, mas pode reutilizar o resto do pipeline (fila BullMQ → worker → Postgres → Redis → WS) sem alteração conceitual.
- **Rate limits**: a SP-API usa *token bucket* por endpoint (não por app como o ML), o que pode exigir um limiter mais granular do que o `limiter: 3 req/3s` global por loja usado hoje em `workers.md`.

## Como encaixar na arquitetura (mesmo princípio de `shopee.md`)

Seguir o mesmo pipeline EDA (`architecture.md`): cliente HTTP dedicado (`amazonClient.js`, uso restrito ao worker), gateway de notificação próprio, filas dedicadas por conta/marketplace, e uma decisão explícita (registrada em `decisions.md`) sobre reusar tabelas existentes com discriminador de marketplace vs. tabelas paralelas antes de escrever qualquer query de agregação nova.

## O que NÃO fazer

Não adicionar chamadas à SP-API no frontend nem em rotas de leitura de `routes/api.js` — mesma regra de fronteira que vale para o Mercado Livre (`architecture.md`, regra 1–3).
