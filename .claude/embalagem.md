# Embalagem — bipagem de etiqueta + vídeo de conferência

> Escopo: o módulo "Embalagem" (`pages/embalagem.html`) — bipar a etiqueta de envio (FLEX ou Mercado Envios), identificar o pedido na tela e gravar um vídeo de conferência da embalagem, guardado por 30 dias. Schema em `database.md` (não repetido aqui). Rotas REST em `api.md`. Job de limpeza em `workers.md`.

## Por que existe

Objetivo operacional (não é uma feature de dashboard/analytics como o resto do sistema): dar ao embalador uma prova em vídeo de que o pedido certo, na quantidade certa, foi para a caixa certa — e permitir conferir esse vídeo depois se o comprador abrir uma devolução alegando item errado/faltando.

## Como a etiqueta vira uma busca de pedido

Etiquetas FLEX e Mercado Envios têm layouts diferentes, mas os dois têm QR code, e (Mercado Envios "coleta") também um código de barras linear. Testado com etiquetas reais do usuário:

- **FLEX (QR)**: `{"id":"47528729907","sender_id":1832985010,"hash_code":"...","security_digit":"0"}` — `id` é o `shipping_id` do Mercado Livre (ID do envio); `sender_id` é o `user_id` do vendedor (bate com `stores.id`).
- **Mercado Envios (QR)**: `{"id":"47521064253","t":"lm"}` — mesmo campo `id`, mesmo formato de `shipping_id`.
- **Mercado Envios (código de barras linear)**: `47521064253` — o mesmo `shipping_id`, sem envelope JSON, dígitos puros.

**Conclusão usada na implementação**: qualquer coisa bipada (QR de qualquer um dos dois tipos, ou barcode linear do Mercado Envios) resolve pro mesmo dado — um `shipping_id` de 11 dígitos. O frontend (`pages/embalagem.html`, função `parseShippingId()`) tenta `JSON.parse` primeiro; se der certo, usa o campo `id`; se não for JSON, usa a string crua (só dígitos) como o próprio `shipping_id`. O backend nunca vê a etiqueta bruta — só recebe o `shipping_id` já extraído.

**Leitor necessário**: a etiqueta FLEX só tem QR (sem barcode linear) — um leitor a laser (só linear) não lê. Precisa de um leitor 2D (imager), que lê QR e barcode linear com o mesmo aparelho.

## `orders.shipping_id` — nova coluna (v21)

Não existia antes: o `shipping_id` (`order.shipping.id` na resposta `/orders/:id` do ML) já passava pelo `handleOrder` (usado no fallback de `shipping_type`, ver `decisions.md`), mas nunca era persistido. Migration v21 adicionou a coluna (indexada, **não** `UNIQUE` — um mesmo envio pode agrupar mais de um pedido quando o comprador leva vários itens juntos no carrinho, o "Pack" impresso na etiqueta). `handleOrder` grava esse valor a cada upsert de pedido — sem alterar nenhum outro comportamento do pipeline ML.

**Pedidos antigos** (criados antes da v21) não têm `shipping_id` retroativo — só pedidos processados a partir do deploy desta migration. Um backfill retroativo (buscar `/orders/:id` de novo pra pedidos antigos só pra extrair o `shipping_id`) não foi feito — mesma classe de decisão já tomada pro backfill de `shipping_type` (ver `decisions.md`), fora de escopo por enquanto.

## Fluxo da tela (`pages/embalagem.html`)

Três abas: **Bipar** (fluxo principal), **Buscar vídeos** (consulta livre) e **Conferência do Dia** (consulta sempre travada em "hoje").

### Aba Bipar — máquina de estado

`idle → loading → recording → saving → idle` (com uma bifurcação de confirmação).

1. **Idle**: campo de bipagem sempre em foco (reforça foco automaticamente ao clicar fora de campos de texto). Câmera já ligada em preview (pedida a permissão assim que a página carrega, via `getUserMedia({video:true,audio:true})`) — assim quando o pedido for identificado, a gravação começa sem precisar de novo popup de permissão.
2. **Bipa** → `parseShippingId()` extrai o `shipping_id` → `GET /api/embalagem/pedido/:shippingId`. Não achou → mensagem de erro, volta pra idle (não inicia gravação nenhuma). **Achou, mas já tinha sido embalado antes** (`already_packed` no payload — a rota já checa `packing_videos` pelo mesmo `shipping_id`, pega o registro mais recente) → `confirm()` avisando quando foi embalado, perguntando se quer gravar de novo mesmo assim; cancelando, não inicia gravação. Confirmando (ou se nunca foi embalado), segue pro passo 3 — e nesse caso um aviso fica visível acima do card enquanto grava, não é só um popup que passa despercebido.
3. **Achou** → mostra na tela, num card grande, todos os pedidos daquele envio (pode ser mais de um — "pack"): imagem (180px), título grande, **quantidade em destaque bem maior que o resto** (pedido explícito do usuário — é o dado mais importante pro embalador conferir), variação (cor/tamanho, se houver) como tags, comprador, e uma grade de detalhes — SKU, valor (`unit_price × quantity`), logística (`shipping_type` formatado com a mesma função `logLabel()` de `top-vendas-online.html`), status do pedido, data/hora da venda, e estoque atual do item (`items.available_quantity`, destacado em vermelho se `≤ 5`). **Todos esses campos já vêm do Postgres** (`orders.raw_data` pra SKU/variação, sem nenhuma chamada nova à API do ML). `MediaRecorder` começa a gravar nesse instante.
4. **Bipa de novo enquanto grava**:
   - Se for a **mesma** etiqueta → entende como "terminei", para a gravação, sobe o vídeo (`POST /api/embalagem/finalizar`, multipart) e mostra confirmação visual.
   - Se for uma etiqueta **diferente** → per pedido explícito do usuário, **pergunta antes** (`confirm()` nativo: "Você bipou uma etiqueta diferente da que está em gravação... Deseja finalizar a atual e começar uma nova?"). Confirmando, finaliza a gravação atual normalmente e já inicia a nova; cancelando, ignora o bipe novo e a gravação em andamento continua intacta.
5. Vídeo salvo com sucesso → mensagem "✅ Pedido embalado", visível por 10s antes de voltar pra idle sozinho.

### Aba Buscar vídeos

Filtros: nº do pedido, comprador, data de/até (`GET /api/embalagem/videos`). Resultado: lista com título/comprador/loja/data/duração + botão "Assistir", que abre um modal com `<video controls>` apontando pra `GET /api/embalagem/videos/:id/file` (Express `res.sendFile` já suporta `Range`, então dá pra avançar/voltar no vídeo sem baixar ele inteiro).

### Aba Conferência do Dia

Mesma listagem/mesmo modal de vídeo da aba anterior (`videoRowHtml()` compartilhada entre as duas — sem duplicar o template). **Sempre abre no dia de hoje** (o campo `Data` é preenchido com a data atual só na 1ª carga, via `todayISO()`) — objetivo é servir de checklist rápido de fim de expediente: "o que já foi bipado hoje" — mas o campo é editável, dá pra trocar pra outro dia se precisar. Filtros: nº do pedido, data, loja (dropdown populado via `DB.getLojas()`, mesmo padrão da Agenda Trello) e comprador. Recarrega automaticamente toda vez que a aba é aberta. **Não tem estado de "conferido"/"revisado" persistido** — é só listagem e filtro (decisão explícita do usuário, mantém o escopo simples sem coluna nova no banco).

**Cards de resumo** (`renderConfKpis()`), acima da lista de vídeos: total bipado no dia/filtro selecionado, contagem por tipo de logística (Flex/Mercado Envios, mesma classificação de `logLabel()`) e um card por loja com pelo menos 1 vídeo no período. Tudo calculado **no frontend**, em cima da mesma resposta de `GET /api/embalagem/videos` que já popula a lista — nenhuma rota nova, nenhuma query extra. Único ajuste de backend: a rota `GET /videos` passou a devolver também `sample_shipping_type` (join `LATERAL` já existente com `orders`, só mais uma coluna no `SELECT`).

**Gráfico de colunas "por hora"** (`renderConfHourChart()`, Chart.js — mesma lib já usada em `top-vendas-online.html`/`analise-vendas-mes.html`): compara a quantidade de bipagens por hora (0-23) do dia selecionado com o dia imediatamente anterior, mesmo filtro de loja se houver. Usa a rota dedicada `GET /api/embalagem/por-hora?date&store_id` (não dá pra calcular isso em cima de `GET /videos` porque ela tem `LIMIT 100` e só cobre 1 dia por chamada) — a rota devolve sempre as 24 horas (zero-fill via `generate_series(0,23)` + `LEFT JOIN`), pra o eixo do gráfico nunca ter buraco mesmo em horas sem nenhuma bipagem.

## Armazenamento

- Vídeos ficam em `server/storage/embalagem-videos/YYYY-MM-DD/<shipping_id>_<timestamp>.webm` (fora do controle de versão — `server/storage/` no `.gitignore`). A pasta do dia é criada automaticamente pelo `multer.diskStorage` na primeira gravação daquele dia.
- Formato: `video/webm` (codec padrão do `MediaRecorder` em Chrome/Firefox) — sem transcodificação no servidor, é só gravado como veio do navegador.
- **Retenção: 30 dias** (pedido explícito do usuário) — job `cleanupPackingVideos` (worker, 03:30 diário) apaga o arquivo em disco e a linha em `packing_videos` de tudo com `created_at` mais velho que 30 dias. Ver `workers.md`.
- **Sem backup/replicação** — se o disco da VPS falhar, os vídeos somem (mesma característica de qualquer arquivo local não versionado). Não implementado por não ter sido pedido; se o volume de devoluções justificar, mover pra object storage (S3-compatible) é o caminho natural — trocar só o `multer.diskStorage` por um storage engine de S3 e o `res.sendFile` por um redirect/proxy pra URL assinada, sem mexer no resto do fluxo.

## Requisito de infraestrutura — `client_max_body_size` no nginx

**Bug real encontrado em produção**: o upload do vídeo travava na tela sem erro ("Salvando vídeo..." infinito) — causa raiz era o nginx, com o limite padrão de 1MB por corpo de requisição, rejeitando o upload do vídeo antes de chegar no Node. **Correção obrigatória de infra** (não é bug de código): adicionar `client_max_body_size 300m;` no bloco `server{}` do nginx — ver `server/nginx-websocket.conf` (template já atualizado) e `deployment.md`.

**Correção de robustez feita em paralelo, no código**: `DB._postForm()` (`js/db.js`) ganhou um timeout próprio via `AbortController` (60s) — antes, se o upload travasse por qualquer motivo (nginx, rede, servidor), o `fetch()` nunca resolvia e a tela ficava presa pra sempre, exigindo recarregar a página pra continuar embalando. Agora, esgotado o timeout, cai no mesmo tratamento de erro de qualquer outra falha (mensagem de erro, volta pra idle, operador pode tentar de novo sem reload). Mensagem de sucesso ("✅ Pedido embalado") fica visível por 10s (era 2,5s) antes de voltar pra idle sozinho — pedido explícito do usuário.

## O que NÃO foi implementado (fora de escopo desta fase)

- Backfill de `shipping_id` para pedidos antigos.
- Vínculo automático entre uma devolução (`returns`) e o vídeo correspondente (hoje a busca é manual, por nº do pedido/comprador/data) — um botão "Ver vídeo da embalagem" direto em `pages/devolucoes.html` é uma extensão natural futura, não implementada agora.
- Notificação/alerta quando uma gravação falha ou fica muito curta (ex: operador bipou e já bipou de novo em 2s por engano) — hoje só mostra o erro se o upload falhar, não valida duração mínima.
- Suporte a múltiplas câmeras/seleção de dispositivo — usa a câmera padrão do navegador (`getUserMedia` sem `deviceId`).
