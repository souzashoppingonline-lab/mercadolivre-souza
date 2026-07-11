# Roadmap

> Escopo: direção futura do produto/arquitetura — o que está planejado, não o que está quebrado agora (`known-bugs.md`) nem uma lista de tarefas granulares acionáveis (`todo.md`). **Ao concluir um item aqui, mova o resultado para `decisions.md` (se envolveu escolha de design) e remova daqui.**

## Multi-marketplace: Shopee e Amazon

Hoje o sistema é 100% Mercado Livre (ver `mercadolivre.md`). Não há trabalho iniciado para Shopee (`shopee.md`) ou Amazon (`amazon.md`) — ambos os arquivos documentam apenas como a integração *deveria* se encaixar na arquitetura existente, sem cronograma definido.

Antes de iniciar qualquer implementação de um novo marketplace, decisão obrigatória a se tomar e registrar em `decisions.md`: **schema compartilhado com discriminador de marketplace** (`orders.marketplace`, `items.marketplace`, etc.) vs. **tabelas paralelas por marketplace** (`shopee_orders`, `shopee_items`). Essa escolha afeta todas as queries agregadas hoje escritas assumindo Mercado Livre como única origem (praticamente todos os endpoints em `api.md`).

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
