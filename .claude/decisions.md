# Decisões Arquiteturais (ADR resumido)

> Escopo: registro histórico de "por que fizemos assim e não de outro jeito". Não repita a mecânica atual (isso já está em `workers.md`/`mercadolivre.md`/etc.) — aqui só o racional e o antes/depois quando existir. **Toda decisão arquitetural nova (escolha entre duas abordagens, correção de um bug de design, trade-off aceito conscientemente) deve ser registrada aqui na mesma tarefa em que for tomada.**

## Webhook → BullMQ → Worker (EDA), nunca chamada direta do frontend à API do ML

**Decisão**: todo dado exibido no dashboard vem do Postgres, populado por webhooks processados de forma assíncrona. **Por quê**: a API do ML tem rate limit por app; se cada carregamento de página disparasse chamadas diretas, o limite estouraria rapidamente com múltiplos usuários/abas abertas. Webhooks + fila absorvem picos e permitem retry/backoff sem impactar a experiência do usuário. Ver `architecture.md`.

## Filas BullMQ separadas por loja (`ml-webhooks-{storeId}`)

**Decisão**: um worker + fila por `store_id`, com `concurrency: 3` e `limiter: 3 req/3s`. **Por quê**: cada loja tem app ML próprio, logo rate limit independente na API do ML. Uma fila global compartilhada faria uma loja com muito tráfego (ou em rate limit) atrasar o processamento de todas as outras. Ver `workers.md`.

## `jobId` estável (`topic:resource:storeId`) no enfileiramento

**Decisão**: usar um `jobId` determinístico em vez de deixar o BullMQ gerar um ID aleatório por job. **Por quê**: o ML pode reenviar o mesmo webhook antes do primeiro job terminar (retry do lado do ML); sem `jobId` estável, isso criaria jobs duplicados processando o mesmo recurso simultaneamente. Ver `workers.md`.

## Cooldown de OAuth 429: 35 min → 5 min

**Decisão histórica**: o cooldown após um 429 no refresh de token era 35 minutos; foi reduzido para 5 minutos. **Por quê**: 35 min era agressivo demais e bloqueava o processamento de webhooks válidos da loja inteira por muito tempo a cada rate limit pontual — 5 min já é suficiente para o ML resetar a janela de rate limit do OAuth, e reduz o tempo em que a loja fica "surda" a eventos reais. Ver `mercadolivre.md`.

## Bug corrigido: loop infinito de retry no 429 do OAuth

**Histórico**: `auth.js` tinha recursão automática ao receber 429 no refresh de token, o que podia gerar um loop de chamadas ao endpoint de OAuth do ML (piorando o próprio rate limit que causou o erro). **Correção aplicada**: `refreshToken` agora lança `OAUTH_RATE_LIMITED` imediatamente no 429, sem retry interno — quem decide o que fazer com o erro é o chamador (`mlClient.getAccessToken`, que aplica o cooldown; ou o worker, que loga e segue). Ver `mercadolivre.md`.

## Compare-and-swap (CAS) no `refreshToken`

**Decisão**: antes de gravar sucesso ou falha de um refresh de token, comparar se `stores.refresh_token` ainda é o mesmo valor lido no início da função (`WHERE refresh_token = $oldRefreshToken`). **Por quê**: existe uma corrida possível entre o refresh automático do worker e uma reconexão manual do usuário (`/auth/login`) acontecendo ao mesmo tempo. Sem CAS, o refresh automático (baseado num token já obsoleto) podia sobrescrever ou invalidar um token novo e válido que acabou de ser salvo pela reconexão manual. Ver `mercadolivre.md`.

## Token "epoch zero" não é mais alvo de refresh automático

**Decisão**: quando um token é invalidado definitivamente (3 falhas consecutivas de refresh), ele é marcado com `token_expires_at = '1970-01-01'`. O `tokenRefreshLoop` detecta esse padrão e **não tenta mais renovar automaticamente** — só notifica via Telegram e exige reconexão manual (`/auth/login?store_id=X`). **Por quê**: tentar refresh num token permanentemente inválido sempre retorna 400 do ML e reescreveria `1970-01-01` de novo, o que destruiria qualquer reconexão manual feita em paralelo pelo usuário (mesma classe de corrida que o CAS resolve, mas nesse caso a solução é simplesmente parar de tentar). Ver `mercadolivre.md`, `workers.md`.

## Vendas ML Turbo (planilha) como fonte financeira oficial, `orders` como fonte operacional

**Decisão**: em vez de tentar reconstruir tarifas/impostos/fretes exatos a partir do payload do webhook `orders_v2` (que nem sempre traz todos os componentes de custo do ML de forma completa), o sistema mantém uma tabela separada (`ml_turbo_sales`) alimentada pela planilha oficial exportada pelo Mercado Turbo, que já vem com esses valores calculados pelo próprio ML. **Trade-off aceito**: a fonte financeira "de verdade" não é tempo real — depende de upload manual periódico. `orders` continua sendo usada para tudo operacional/tempo real, mas não deve ser tratada como fonte de verdade para fechamento financeiro. Ver `finance.md`, `business-rules.md`.

## `account` da planilha Turbo sem FK para `stores`

**Decisão consciente (trade-off)**: o campo `ml_turbo_sales.account` é texto livre, sem relação com `stores.id`. **Por quê**: a planilha do Mercado Turbo identifica a conta por nome/nickname, não por ID interno do ML, e o mapeamento de aliases de coluna (`finance.md`) já lida com naming inconsistente entre exports. **Custo aceito**: join entre `ml_turbo_sales` e `stores` não é possível diretamente; renomear uma loja não retroage sobre vendas já importadas (é preciso reimportar).

## `GET /api/vendas/hoje` como endpoint dedicado (não reaproveita filtro de período)

**Decisão**: existe uma rota específica para "vendas de hoje" em vez de reusar `GET /api/vendas/detalhado?days=1` (que poderia ter drift de fuso horário/cache). **Por quê**: KPIs do dia precisam ser exatos e sempre relativos a `CURRENT_DATE`, independente de qualquer filtro de período selecionado em outra tela — um endpoint dedicado remove ambiguidade. Ver `api.md`.

## Gráfico semanal usa `TO_CHAR(DATE_TRUNC('week', sale_date), 'YYYY-MM-DD')`

**Nota técnica preservada**: `sale_date` em `ml_turbo_sales` é tipo `DATE` (não `TIMESTAMPTZ`), então o agrupamento semanal usa `DATE_TRUNC` diretamente sem conversão de fuso horário — ao contrário de `orders.date_created`, que é `TIMESTAMPTZ` e por isso outras queries fazem `AT TIME ZONE 'America/Sao_Paulo'` antes de truncar. Misturar os dois padrões sem essa distinção gera resultados sutilmente errados perto da virada do dia/semana.
