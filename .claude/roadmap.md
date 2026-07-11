# Roadmap

> Escopo: direção futura do produto/arquitetura — o que está planejado, não o que está quebrado agora (`known-bugs.md`) nem uma lista de tarefas granulares acionáveis (`todo.md`). **Ao concluir um item aqui, mova o resultado para `decisions.md` (se envolveu escolha de design) e remova daqui.**

## Multi-marketplace: Shopee e Amazon

Em andamento — camada comum "Marketplace Engine" criada em `server/src/marketplaces/` (decisão registrada em `decisions.md`). Status por marketplace: `mercadolivre.md` (único em produção), `amazon.md` (cliente implementado, desconectado, credenciais parciais), `shopee.md` (bloqueada — app em aprovação, só stub).

**Decisão pendente de confirmação** (bloqueia ligar a Amazon a qualquer rota/worker — ver `todo.md`): **schema compartilhado com coluna `marketplace` discriminadora** (`stores.marketplace`, `orders.marketplace`, `items.marketplace`) vs. **tabelas paralelas por marketplace** (`amazon_orders`, `amazon_items`). Proposta em avaliação: coluna discriminadora, por preservar todos os endpoints de agregação já existentes (`api.md`) funcionando para múltiplos marketplaces sem duplicar rota/query — mas ainda não confirmada com o usuário.

## Descomissionamento do sistema antigo (`ml-dashboard.service`)

Ver checklist completo em `deployment.md` → "Transição do sistema antigo". Resumo do critério de conclusão:
1. Webhook do ML apontando só para `/webhooks/ml` deste backend.
2. `webhook_logs.status='processed'` estável, sem acúmulo de `failed`.
3. Dashboard novo confirmadamente exibindo dados reais do Postgres em todas as telas relevantes.

Status: não confirmado neste documento — verificar no ambiente de produção antes de desligar o serviço legado.

## Publicidade (Ads) — endpoint ainda exploratório

`GET /api/publicidade` (ver `api.md`) hoje testa múltiplos endpoints de advertising da API do ML por loja até um responder OK, sem contrato de dados estável — é usado como diagnóstico (`server/test-ads.js` é um script de exploração manual do mesmo problema). Falta decidir o endpoint definitivo da API de Advertising do ML a adotar e desenhar uma tabela própria (`ad_campaigns`, `ad_metrics`) em vez de repassar a resposta crua do ML para o frontend.

## Cobertura de índice único para `messages.pack_id`

Ver `known-bugs.md` item 4 — `migrate-v10.sql` (índice único `messages_pack_id_unique`) não está na lista aplicada por `db/migrate.js`. Antes de qualquer trabalho novo em `messages`/mensagens, isso precisa ser corrigido (é pré-requisito, não trabalho novo em si).

## KPIs por loja com cache dedicado

`redis.md`/`known-bugs.md` apontam que a chave `kpis:{storeId}` é invalidada pelo worker mas nunca lida por nenhuma rota — sugere uma feature de "resumo de KPIs por loja individual" que foi cogitada e não implementada. Se houver demanda por essa tela, o cache já está parcialmente preparado do lado da invalidação.
