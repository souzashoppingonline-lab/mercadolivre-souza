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

**Leitor USB com layout de teclado incompatível — caracteres do JSON saem trocados**: um leitor 2D USB (emula teclado HID) testado pelo usuário lê o mesmo QR FLEX só que com os caracteres especiais do JSON substituídos por causa de um layout de teclado diferente do esperado pelo SO — visualmente parecia `"` → `^`, `:` → `ç`, `{` sumindo, `}` virando `{` (ex.: `^id^ç^47538810049^,^sender_id^ç1662123376,...,^security_digit^ç^0^{`, equivalente a `{"id":"47538810049",...}`). **1ª tentativa de correção (não funcionou)**: uma função que desfazia essa troca de caracteres específica antes do `JSON.parse` — falhou em produção porque os caracteres reais enviados pelo leitor não são exatamente os codepoints Unicode que pareciam ser ao copiar/colar (o `^`/`ç` visualmente idênticos podem ser outro caractere por baixo, variando por leitor/layout — não dá pra fixar qual). **Correção que funciona**: `parseShippingId()` não tenta mais adivinhar/desfazer a troca — em vez disso, `extractIdNearby()` procura o texto literal `id` (não `sender_id`, excluído por exigir que o caractere antes de "id" não seja letra/underscore) seguido de perto (até 4 caracteres quaisquer) por uma sequência de 6+ dígitos. Funciona não importa quais caracteres o leitor tenha posto no lugar de `"`/`:`/`{`/`}`, porque não depende de reconhecer nenhum deles — só da posição relativa entre o texto "id" e os dígitos do `shipping_id`. Fallback final continua sendo "só dígitos" (pro código de barras linear puro, que não tem a palavra "id"). A mensagem de erro "Pedido não encontrado" também passou a mostrar o `shipping_id` pesquisado, pra facilitar diagnóstico em campo sem precisar abrir o DevTools.

## `orders.shipping_id` — nova coluna (v21)

Não existia antes: o `shipping_id` (`order.shipping.id` na resposta `/orders/:id` do ML) já passava pelo `handleOrder` (usado no fallback de `shipping_type`, ver `decisions.md`), mas nunca era persistido. Migration v21 adicionou a coluna (indexada, **não** `UNIQUE` — um mesmo envio pode agrupar mais de um pedido quando o comprador leva vários itens juntos no carrinho, o "Pack" impresso na etiqueta). `handleOrder` grava esse valor a cada upsert de pedido — sem alterar nenhum outro comportamento do pipeline ML.

**Pedidos antigos** (criados antes da v21) não têm `shipping_id` retroativo. **Auto-resolver ML sob demanda (self-heal)**: quando o bipe é numérico (shipment id do ML) e a busca por `shipping_id` no banco não acha nada — pedido recém-criado, `shipping_id` ainda nulo, ou pedido nem processado — a rota `GET /pedido/:shippingId` chama `resolveMlByShipment()`: itera as lojas ML com token, `ml.getShipment(id, storeId)` (a dona responde 200 e traz `order_id`; as outras dão 403 e são puladas), busca o pedido com `ml.getOrder`, faz upsert em `orders` **gravando o `shipping_id`**, e re-consulta. Espelha a auto-busca que a Shopee já tinha (`refreshShopeeTrackingOnDemand`). É uma "ação pontual explícita em rota" chamando o `mlClient` (exceção permitida à regra de fronteira, ver `architecture.md`). Tudo defensivo — qualquer falha cai na mensagem de "não encontrado" de sempre.

**Fonte da logística no self-heal**: `order.shipping.logistic_type` (resposta de `/orders/:id`) às vezes vem **vazio** em venda recém-criada, o que deixava o pedido gravado com `shipping_type=''` → a tela mostrava "Desconhecido" (bug relatado pelo usuário, ago/2026). Correção: `resolveMlByShipment()` monta a logística do próprio **shipment** já buscado (fonte mais confiável do tipo), com precedência `ship.logistic_type → ship.logistic.type → ship.mode → order.shipping.logistic_type`. O upsert continua com `COALESCE(NULLIF(EXCLUDED.shipping_type,''), orders.shipping_type)` — nunca sobrescreve um tipo já conhecido com vazio.

## Fluxo da tela (`pages/embalagem.html`)

Abas: **Bipar** (fluxo principal), **Buscar vídeos** (consulta livre), **Conferência do Dia** (consulta sempre travada em "hoje"), **Histórico** (tendência ao longo de semanas/meses), **Relatórios** (produtividade por embalador), **Relatório do Dia** (fechamento em PDF de dia/semana/mês), **Auditoria** (o que falta bipar) e **Erros**.

### Acesso por papel — admin nunca ativa a câmera (`initEmbalagemPorPapel()`)

Pedido explícito do usuário: papel **admin** entra nesta página só pra **coletar dado** (olhar relatórios), nunca pra bipar — a câmera (`getUserMedia`) não deveria nem ser pedida. Papel **embalagem** (o operador de verdade) continua **exatamente como sempre foi**.

- `initEmbalagemPorPapel()` (chamada no lugar do antigo `initCamera()` direto no fim do script) consulta `/auth/staff/me` uma vez ao carregar a página:
  - **`role === 'admin'`**: esconde a aba **Bipar** (`tabBtnBipar`, `display:none` — é a ÚNICA aba com `getUserMedia`, todas as outras já são relatório/histórico/busca de vídeo gravado) e pousa direto na aba **Conferência do Dia** (já mostra o resumo de hoje, é o destino natural de quem só quer olhar dado). `initCamera()` **nunca** é chamado.
  - **`role === 'embalagem'` (ou sem staffAuth ligado, `staff === null`)**: comportamento de sempre — `initCamera()` chamado normalmente, aba Bipar visível e ativa por padrão.
- Reusa `getCurrentStaffUser()` (já existente, antes só usado pra anexar `staff_user_name` no vídeo salvo).

### Aba Bipar — máquina de estado

`idle → loading → recording → saving → idle` (com uma bifurcação de confirmação).

1. **Idle**: campo de bipagem sempre em foco (reforça foco automaticamente ao clicar fora de campos de texto). Câmera já ligada em preview (pedida a permissão assim que a página carrega, via `getUserMedia({video:true,audio:true})`) — assim quando o pedido for identificado, a gravação começa sem precisar de novo popup de permissão.
2. **Bipa** → `parseShippingId()` extrai o `shipping_id` → `GET /api/embalagem/pedido/:shippingId`. Não achou → mensagem de erro, volta pra idle (não inicia gravação nenhuma). **Achou, mas já tinha sido embalado antes** (`already_packed` no payload — a rota já checa `packing_videos` pelo mesmo `shipping_id`, pega o registro mais recente) → `confirm()` avisando quando foi embalado, perguntando se quer gravar de novo mesmo assim; cancelando, não inicia gravação. Confirmando (ou se nunca foi embalado), segue pro passo 3 — e nesse caso um aviso fica visível acima do card enquanto grava, não é só um popup que passa despercebido.
3. **Achou** → mostra na tela, num card grande, todos os pedidos daquele envio (pode ser mais de um — "pack"): imagem (180px), título grande, **quantidade em destaque bem maior que o resto** (pedido explícito do usuário — é o dado mais importante pro embalador conferir), variação (cor/tamanho, se houver) como tags, comprador, e uma grade de detalhes — SKU, valor (`unit_price × quantity`), logística (`shipping_type` formatado com a mesma função `logLabel()` de `top-vendas-online.html`), status do pedido, data/hora da venda, e estoque atual do item (`items.available_quantity`, destacado em vermelho se `≤ 5`). **Quase todos esses campos já vêm do Postgres** (`orders.raw_data` pra SKU/variação, sem chamada à API do ML) — **exceto as medidas da caixa**.

**Medidas da caixa (C×L×A · peso)**: **cacheadas no banco** (`items.package_dims` JSONB, v68) — **sem GET no ML na hora do bipe** (crucial: em dia de muita embalagem o GET on-demand estouraria rate limit). O **worker** (`handleItem`) já busca o item no sync e, de graça, extrai as dimensões via `packageDimsFromItem()` (módulo `server/src/mlDims.js`, compartilhado) dos atributos `PACKAGE_LENGTH`/`PACKAGE_WIDTH`/`PACKAGE_HEIGHT`/`PACKAGE_WEIGHT` (fallback `shipping.dimensions`) e grava em `items.package_dims`. A rota de bipe faz `LEFT JOIN items` e devolve `dimensoes` do banco. **Cache-on-first-bipe**: se o item ainda está com `package_dims` NULL, a rota faz **UM** `getItem`, grava em `items.package_dims` e usa — nas bipagens seguintes vem direto do banco, **0 GET** (best-effort, 1× por item único do pack, nunca derruba o bipe → imune a rate limit, pois nunca repete o GET do mesmo item). Também é preenchido de graça por (a) `handleItem` (webhook de item) e (b) `syncPrecos` (05:00 diário, que já dá `getItem` em todo item ativo). **Só aparece se o vendedor preencheu** esses atributos no anúncio (muitos deixam em branco → sem linha). Opcional: `node server/scripts/backfillPackageDims.js` popula todos os itens de uma vez (getItem em lotes com pausa), mas não é necessário — o cache-on-first-bipe resolve sozinho conforme se bipa. **Imagem: foto da variação específica** (não a foto principal do produto) — extraída de `item.variations[]` procurando correspondência com `variation_attributes`; se há uma única variação, usa ela (é garantido que foi a comprada); se há múltiplas, faz match exato por `value_name`; se não houver variação ou match falhar, fallback pra `item.thumbnail` ou foto principal. Shopee usa a foto do modelo em `shopee_item_data.models`, indo pelo `model_id` do pedido. Evita confusão do embalador quando há múltiplas variações (cores, tamanhos, etc.). `MediaRecorder` começa a gravar nesse instante.
4. **Bipa de novo enquanto grava**:
   - Se for a **mesma** etiqueta → entende como "terminei", para a gravação (rápido, `MediaRecorder.stop()`, não depende de rede) e sobe o vídeo em segundo plano (`uploadPackingVideo()`, `POST /api/embalagem/finalizar` multipart, **sem `await`**) — o operador já pode bipar a próxima etiqueta imediatamente, não espera o upload terminar. Se o upload falhar, uma mensagem de erro aparece depois (mesma `showScanMsg`), mesmo que o operador já tenha ido pra outro pedido. Tela de "Pedido embalado" fica visível só 2s antes de voltar pro estado pronto pra bipar (era 10s — atrapalhava o ritmo do embalador). Ver `decisions.md`.
   - Se for uma etiqueta **diferente** → per pedido explícito do usuário, **pergunta antes** (`confirm()` nativo: "Você bipou uma etiqueta diferente da que está em gravação... Deseja finalizar a atual e começar uma nova?"). Confirmando, finaliza a gravação atual normalmente e já inicia a nova; cancelando, ignora o bipe novo e a gravação em andamento continua intacta.
5. Vídeo salvo com sucesso → mensagem grande de 2 linhas ("✅ Pedido embalado com sucesso" / "Pode seguir para o próximo pedido", `showBigSuccessMsg()`), visível por 2s antes de voltar pra idle sozinho (texto exato pedido pelo usuário).

### Destaque piscante em quantidade, variação e SKU (card do pedido)

Pedidos explícitos do usuário, com prints mostrando o card real: **quantidade** ("1 un."), **variação** ("TIPO: PEIXE") e agora **SKU** passavam despercebidas pro embalador numa olhada rápida, mesmo sendo os dados mais importantes pra conferir (são os três identificadores únicos/críticos do pedido). Solução: animação CSS de piscar (`@keyframes embQtyBlink`), aplicada via classe `.attention` — puro CSS, sem lógica condicional, sempre piscando enquanto o card está na tela. `embQtyBlink` pulsa um glow amarelo (`drop-shadow`) + leve zoom (`scale`); ciclo de 0.9s.

- **Quantidade**: 60px font-weight 900, com seta vermelha piscante (`embArrowBlink`) apontando pra "está aqui".
- **Variação**: 30px, uppercase, tags (`emb-order-tag`) com animação `embTagBlink` (inverte fundo/texto de discreta pra amarelo sólido com sombra).
- **SKU**: **42px, NOVO** — movido para posição prominente (após quantidade/variação, antes de comprador/detalhes) com pulsação `embQtyBlink` + fundo discreto + borda. Sempre visível quando houver SKU, não vai pra grade de detalhes escondido. Identificador exato do item ordenado — evita confusão com produtos multi-variação.
- **Logística**: **badge grande piscante amarelo** (`.emb-logistica-badge`, 24px font-weight 900, uppercase, ocupa a linha inteira da grade), animação `emb-log-piscar` (1s, alterna amarelo sólido ↔ amarelo escuro com glow). Pedido explícito do usuário — o embalador precisa ver o tipo de envio (Full/Flex/Mercado Envios/Coleta) de relance antes de embalar. Quando `logLabel()` cai no fallback (tipo vazio/desconhecido), a badge mostra **"Logística indisponível"** com ícone de alerta e variação de cor (`.desconhecida`) — o back tenta preencher o tipo pelo shipment (ver self-heal acima), então esse estado deve ser raro.

### Últimos bipados (tabela abaixo da câmera)

No painel direito da aba Bipar, abaixo do preview da câmera, um card **"Últimos bipados"** mostra os **10 pedidos mais recentes** gravados, numa tabela pequena e colorida (Hora · Pedido · Comprador · Loja · Logística com chip colorido por tipo). Reaproveita `GET /api/embalagem/videos` (já ordenado por `created_at DESC`) — **sem rota nova**, pega os 10 primeiros no frontend (`loadUltimosBipados()`). Atualiza sozinho: no load, a cada 30s (reflete bipagens de outras estações de embalagem) e imediatamente após cada vídeo salvo com sucesso (a linha nova entra com um flash amarelo, `@keyframes embUltNew`). Chip de logística usa a mesma classificação `logLabel()`; Shopee é forçado pelo `marketplace` da linha. Objetivo: o embalador enxerga de relance o que acabou de passar, sem trocar de aba.

### Aba Buscar vídeos

Filtros: **rastreio ou pedido**, comprador, data de/até, marketplace (`GET /api/embalagem/videos`). O campo "Rastreio ou Pedido" casa `pv.shipping_id` (o valor bipado — **tracking `BR…` da Shopee** ou `shipping_id` do ML) **ou** um `order_id` em `pv.order_ids` — pro Shopee o operador tem a etiqueta (rastreio) na mão, não o nº do pedido. Resultado: lista com título/comprador/loja/data/duração + botão "Assistir", que abre um modal com `<video controls>` apontando pra `GET /api/embalagem/videos/:id/file` (Express `res.sendFile` já suporta `Range`, então dá pra avançar/voltar no vídeo sem baixar ele inteiro).

### Aba Conferência do Dia

Mesma listagem/mesmo modal de vídeo da aba anterior (`videoRowHtml()` compartilhada entre as duas — sem duplicar o template). **Sempre abre no dia de hoje** (o campo `Data` é preenchido com a data atual só na 1ª carga, via `todayISO()`) — objetivo é servir de checklist rápido de fim de expediente: "o que já foi bipado hoje" — mas o campo é editável, dá pra trocar pra outro dia se precisar. Filtros: nº do pedido, data, loja (dropdown populado via `DB.getLojas()`, mesmo padrão da Agenda Trello) e comprador. Recarrega automaticamente toda vez que a aba é aberta. **Não tem estado de "conferido"/"revisado" persistido** — é só listagem e filtro (decisão explícita do usuário, mantém o escopo simples sem coluna nova no banco).

**Cards de resumo** (`renderConfKpis()`), acima da lista de vídeos: total bipado no dia/filtro selecionado, contagem por tipo de logística (Flex/Mercado Envios, mesma classificação de `logLabel()`) e um card por loja com pelo menos 1 vídeo no período. Tudo calculado **no frontend**, em cima da mesma resposta de `GET /api/embalagem/videos` que já popula a lista — nenhuma rota nova, nenhuma query extra. Único ajuste de backend: a rota `GET /videos` passou a devolver também `sample_shipping_type` (join `LATERAL` já existente com `orders`, só mais uma coluna no `SELECT`).

**Cards são clicáveis** (`openConfDrill()`): clicar em qualquer um (Bipados/Flex/Mercado Envios/uma loja) abre um modal listando só os pedidos daquela fatia (`videoRowHtml()`, mesmo template da lista principal, com botão "Assistir" que abre o vídeo por cima). Filtro é feito em `confRows` (array já carregado em memória, guardado em `loadConferenciaDia()`) — nenhuma chamada nova ao backend por clique.

**Card "Tempo médio / pedido"**: usa o `duration_seconds` que `packing_videos` já grava (é literalmente o tempo de gravação — da identificação do pedido até bipar de novo pra finalizar, ver "Fluxo da tela" acima) e `order_ids` (quantos pedidos aquele envio agrupa). Fórmula: `SUM(duration_seconds) / SUM(quantidade de pedidos por envio)` — soma total dividida por soma total, não "média das médias", pra um envio de 5 pedidos pesar mais que um de 1 pedido só no cálculo. **Decisão explícita do usuário**: a métrica é por **pedido** (`orders.ml_id`/`order_ids`), não por item — um pedido com 2+ itens dentro continua contando como 1 pedido, sem dividir pela quantidade. Vídeos sem `duration_seconds` (ex: upload que falhou antes de mandar essa info) são ignorados no cálculo, não entram como zero.

**Gráfico de colunas "por hora"** (`renderConfHourChart()`, Chart.js — mesma lib já usada em `top-vendas-online.html`/`analise-vendas-mes.html`): compara a quantidade de bipagens por hora (0-23) do dia selecionado com o dia imediatamente anterior, mesmo filtro de loja se houver. Usa a rota dedicada `GET /api/embalagem/por-hora?date&store_id` (não dá pra calcular isso em cima de `GET /videos` porque ela tem `LIMIT 100` e só cobre 1 dia por chamada) — a rota devolve sempre as 24 horas (zero-fill via `generate_series(0,23)` + `LEFT JOIN`), pra o eixo do gráfico nunca ter buraco mesmo em horas sem nenhuma bipagem.

### Aba Auditoria — "expedição do dia" (o que falta bipar)

Cruza os pedidos que **precisam ser expedidos** com `packing_videos` pra dizer, numa tabela colorida, o que **já foi bipado** e o que **falta** — objetivo do usuário: rodar no dia pra saber o que ainda tem que sair (e o que comprar). Rota `GET /api/embalagem/auditoria?only_printed&only_missing` (`loadAuditoria()` no front).

**Decisão-chave (explícita do usuário)**: a base é o **status de envio**, NÃO a data de criação nem corte por horário (a ideia inicial de "FLEX antes/depois das 12h + ME no dia seguinte" foi descartada — o próprio status de expedição do ML/Shopee já diz o que está pendente). Critério de "precisa sair":
- **ML** (`orders`): `shipping_status = 'ready_to_ship'` e `shipping_type` ∈ FLEX (`self_service`/`flex`) ou Mercado Envios (`xd_drop_off`/`me1`/`me2`/`cross_docking`) — Full é excluído (não é embalado aqui). `shipping_substatus='printed'` = **etiqueta impressa** (badge/filtro).
- **Shopee** (`shopee_order_data`): `order_status` ∈ (`READY_TO_SHIP`, `PROCESSED`); logística vem de `raw_data->>'shipping_carrier'` classificada em **Entrega Rápida** / **Agência** (senão mostra o carrier cru). `PROCESSED` conta como "etiqueta impressa".

**Bipado?** = existe `packing_videos pv` com `o.ml_id = ANY(pv.order_ids)` **ou** `pv.shipping_id = o.shipping_id` (ML) **ou** `pv.shipping_id = sod.tracking_number` (Shopee). Resposta traz `items[]` (com `logistica`, `printed`, `bipado`, `date_created`, `etiqueta_impressa_at`) + `resumo` (`total`/`bipados`/`faltando`/`por_logistica`). Filtros: "só o que falta bipar", "só etiqueta impressa". A aba tem **badge vermelho** com quantos faltam (primado no load via `primeAudBadge()`, igual ao badge de Erros). Linhas verdes = bipado, vermelhas = falta.

**Busca direta** (`search`): campo "Pedido ou rastreio" — casa `o.ml_id`/`o.shipping_id`/`sod.tracking_number` (`ILIKE`) e **ignora os filtros de status/logística/período**, pra responder "esse pedido específico foi bipado?" mesmo que já tenha sido expedido (não está mais na lista de pendentes). Os filtros de período são pelos presets (3/5/10/15/21/30 dias) ou intervalo personalizado, sobre a **data da venda**.

**Colunas** (pedido do usuário): Pedido · Produto · **Data da venda** (`orders.date_created`) · Loja · Logística · **Etiqueta impressa (data/hora)** · Bipado? · **Bipado em (data/hora)** — o `bipado`/`bipado_at` vêm de um `LEFT JOIN LATERAL` no `packing_videos` (vídeo mais recente que casa por `order_ids`/`shipping_id`/`tracking_number`), então a coluna mostra exatamente quando foi bipado.

**Aviso "já foi bipado" ao bipar**: o `GET /pedido/:key` retorna `already_packed` (via `lastPacking(key, orderIds)`), e o front dá um `confirm()` bloqueante "⚠️ Esse pedido já foi embalado em {data} — gravar de novo?". `lastPacking` casa por `shipping_id` **ou** sobreposição de `order_ids` (`&&`), então avisa mesmo que o pack tenha sido gravado por um código diferente do bipado agora. A data/hora da etiqueta vem do **`print_jobs.printed_at`** (LATERAL casando `pj.shipping_id` com `o.shipping_id` ou `sod.tracking_number`, mais recente) — é o instante real em que o print-agent imprimiu. Quando não há registro de impressão pelo agente mas o status já é "impressa" (`printed`), mostra só o badge "impressa"; senão "—".

**Dependência Shopee**: o `shipping_carrier` **não** era buscado no `get_order_detail` (só `total_amount/order_status/item_list/create_time/update_time`); foi adicionado à lista de `response_optional_fields` em `shopeeClient.getOrderDetail`. Pedidos Shopee sincronizados **antes** desse deploy não têm o carrier no `raw_data` → caem no rótulo genérico "Shopee" até serem re-sincronizados (o polling atualiza no próximo ciclo).

**Gráfico de colunas "por loja"** (`renderConfStoreChart()`), logo abaixo do gráfico por hora: uma coluna por loja com contagem de bipagens no dia/filtro selecionado, cada loja com uma cor distinta (`STORE_PALETTE`, cicla se houver mais lojas que cores) e um contorno (`borderColor`) mais forte que o preenchimento — mesma paleta de `--primary`/`--blue`/`--green`/`--orange`/`--purple`/`--teal`/`--red` do `style.css`. Calculado em cima de `confRows` (mesmo array dos cards e do drill-down), sem chamada nova ao backend. Ambos os gráficos da aba usam `animation: { duration: 700, easing: 'easeOutQuart' }` (Chart.js) em vez do padrão da lib, pra dar uma transição visível ao trocar de dia/loja no filtro.

## Armazenamento

- Vídeos ficam em `server/storage/embalagem-videos/YYYY-MM-DD/<shipping_id>_<timestamp>.webm` (fora do controle de versão — `server/storage/` no `.gitignore`). A pasta do dia é criada automaticamente pelo `multer.diskStorage` na primeira gravação daquele dia.
- Formato: `video/webm` (codec padrão do `MediaRecorder` em Chrome/Firefox) — sem transcodificação no servidor, é só gravado como veio do navegador.
- **Retenção: 30 dias** (pedido explícito do usuário) — job `cleanupPackingVideos` (worker, 03:30 diário) apaga o arquivo em disco e a linha em `packing_videos` de tudo com `created_at` mais velho que 30 dias. Ver `workers.md`.
- **Sem backup/replicação** — se o disco da VPS falhar, os vídeos somem (mesma característica de qualquer arquivo local não versionado). Não implementado por não ter sido pedido; se o volume de devoluções justificar, mover pra object storage (S3-compatible) é o caminho natural — trocar só o `multer.diskStorage` por um storage engine de S3 e o `res.sendFile` por um redirect/proxy pra URL assinada, sem mexer no resto do fluxo.

## Requisito de infraestrutura — `client_max_body_size` no nginx

**Bug real encontrado em produção**: o upload do vídeo travava na tela sem erro ("Salvando vídeo..." infinito) — causa raiz era o nginx, com o limite padrão de 1MB por corpo de requisição, rejeitando o upload do vídeo antes de chegar no Node. **Correção obrigatória de infra** (não é bug de código): adicionar `client_max_body_size 300m;` no bloco `server{}` do nginx — ver `server/nginx-websocket.conf` (template já atualizado) e `deployment.md`.

**Correção de robustez feita em paralelo, no código**: `DB._postForm()` (`js/db.js`) ganhou um timeout próprio via `AbortController` (60s) — antes, se o upload travasse por qualquer motivo (nginx, rede, servidor), o `fetch()` nunca resolvia e a tela ficava presa pra sempre, exigindo recarregar a página pra continuar embalando. Agora, esgotado o timeout, cai no mesmo tratamento de erro de qualquer outra falha (mensagem de erro, volta pra idle, operador pode tentar de novo sem reload).

**Upload não-bloqueante (pedido explícito do usuário, revertendo a decisão acima de "esperar o upload")**: o upload demorado estava impedindo o embalador de já bipar o próximo pedido. `finalizeCurrent()` não dá mais `await` em `uploadPackingVideo()` — a gravação para (`MediaRecorder.stop()`, não depende de rede) e o upload roda em segundo plano, com seu próprio try/catch; se falhar, o erro aparece depois via `showScanMsg()`, mesmo que o operador já tenha ido pra outro pedido. Tela de sucesso reduzida de 10s pra **2s** (ver "Fluxo da tela" acima) — outro pedido explícito do usuário, pra não atrapalhar o ritmo. Ver `decisions.md`.

## Link Devoluções → vídeo (`pages/devolucoes.html`)

Coluna "Vídeo" na tabela de devoluções mostra um botão "Assistir" pros pedidos que têm gravação. `returns.order_id` é o vínculo — a mesma chave usada em `packing_videos.order_ids` (array). Implementação: `load()` (em `devolucoes.html`) coleta todos os `order_id` da página carregada e faz **uma única chamada em lote** (`GET /api/embalagem/videos-por-pedidos?order_ids=...`), preenchendo a coluna via `Object.entries(map)` — sem N+1 (1 request pra tabela inteira, não 1 por linha). Clicar em "Assistir" abre um modal simples (`<video controls>`, `dev-modal-backdrop`) reaproveitando o mesmo endpoint de streaming `GET /api/embalagem/videos/:id/file`.

**Como saber se um pedido teve devolução, e quando**: a tabela `returns` já grava isso — `order_id` (vínculo com o pedido), `date` (o `date_created` do claim, ou seja, o momento exato em que o comprador abriu a reclamação/devolução no ML), `status`/`reason`. Populado em tempo real pelo webhook `post_purchase` (`handlePostPurchase` em `worker.js`) + sync retroativo (`syncReturns`, botão "Importar histórico ML" na própria página).

### Aba Histórico

Complementa a Conferência do Dia (que só compara "dia selecionado vs. dia anterior") com uma visão de tendência real ao longo do tempo — período configurável (7/30/90 dias) e filtro de loja (mesmo `loadLojasSelect()` reaproveitado da Conferência, generalizado a partir de `loadLojasConferencia()` pra aceitar qualquer `<select>`).

- **Rota**: `GET /api/embalagem/historico?days&store_id` — série diária zero-fill (`generate_series` de dias, mesmo padrão de `/por-hora`), devolvendo por dia: `count` (bipagens), `duration_sum`/`duration_orders` (não uma média já pronta — o frontend calcula `SUM/SUM`, mesmo raciocínio do card "Tempo médio / pedido" da Conferência do Dia, pra não distorcer com média das médias).
- **Cards**: total no período, média de bipagens por dia, tempo médio/pedido do período inteiro.
- **Gráfico 1** (`histCountChart`, colunas): bipagens por dia.
- **Gráfico 2** (`histTimeChart`, linha preenchida): tempo médio por pedido, dia a dia — é aqui que dá pra ver se o tempo de embalagem está melhorando ou piorando ao longo das semanas, não só num dia isolado.

### Aba Relatórios — estatísticas por embalador e marketplace

Mostra breakdown de produtividade da equipe: quem embalou quantos pedidos, e em qual marketplace (ML vs. Shopee). Rastreia `staff_user_id` e `staff_user_name` em cada vídeo gravado, permitindo análise de desempenho por embalador.

- **Rastreamento de staff**: quando o embalador grava um vídeo em `POST /api/embalagem/finalizar`, o frontend captura o usuário logado (`GET /auth/staff/me`) e envia `staff_user_id`/`staff_user_name` no upload. As colunas em `packing_videos` + o índice `(staff_user_id, created_at DESC)` são criados pela **migration v81** — antes dela nenhuma migration criava essas colunas (a doc atribuía erradamente à v45, que trata de chave composta da Shopee), então num banco criado do zero o INSERT do vídeo falhava e caía em `logEmbalagemError('db_insert')`.
- **Rota**: `GET /api/embalagem/relatorio?date_from&date_to&staff_user_name&marketplace` — agregação por embalador e marketplace, devolvendo `staff_user_name`, `marketplace` (`ML`/`SHOPEE`), `count` (quantidade de pedidos embalados), `total_duration` (tempo total de gravação), `total_orders` (número de pedidos — diferente de `count` se houver packs com múltiplos pedidos).
- **Cards de resumo**: total embalado no período, número de embaladores únicos, tempo total, tempo médio por pedido.
- **Gráfico** (colunas agrupadas): embalador no eixo X, duas cores (ML/Shopee) por coluna, altura = quantidade de pedidos. Cada marketplace com cor distinta (ML amarelo, Shopee vermelho).
- **Tabela de detalhe**: lista todos os registros agregados — cada linha é um embalador + marketplace + seus números (pedidos, duração, média).
- **Filtros**: data de/até, embalador (dropdown), marketplace (Todos/ML/Shopee).

Serve pra insights de produtividade ("Quem embalou mais pedidos?", "Qual marketplace demanda mais tempo?") sem necessidade de consulta SQL manual.

### Aba Relatório do Dia — fechamento em PDF (dia / semana / mês)

Relatório fechado da expedição pra impressão/arquivo: tudo que aconteceu no período, com gráficos, pronto pra salvar em PDF. É a aba de **fechamento** (o que aconteceu), enquanto Conferência do Dia é operação ao vivo e Relatórios é só produtividade por pessoa.

- **Três recortes no mesmo lugar**, botões Dia / Semana / Mês. Não são três telas: só muda o intervalo `[from, to]` mandado pra `GET /api/embalagem/relatorio-periodo`, que devolve o payload inteiro numa chamada.
  - **Dia**: a data escolhida.
  - **Semana**: **segunda a sexta** — não há expedição no fim de semana, então o relatório semanal nunca inclui sábado/domingo. Domingo é tratado como pertencente à semana que **acabou** (não à que vai começar).
  - **Mês**: dia 1 ao último dia do mês.
  - Setas `◀ ▶` navegam pro período anterior/seguinte respeitando o recorte (±1 dia, ±1 semana, ±1 mês) e o input de data é ancorado no início do período em semana/mês (`rdSnap`), pra não ficar ambíguo qual semana está na tela.
- **Filtros**: marketplace (Todos/ML/Shopee) e loja — repassados como `marketplace`/`store_id`; aparecem no cabeçalho da tela e do PDF.
- **Cards**: pedidos embalados, envios bipados, tempo médio por pedido, tempo total embalando, embaladores, erros. Em período de mais de um dia entram ainda dias com movimento, média por dia trabalhado, melhor dia e horário de pico.
- **Gráficos** (Chart.js): volume e tempo por dia (colunas de bipagens + linha de tempo médio/pedido em eixo secundário — só quando o período tem mais de um dia), bipagens por hora (0-23), pedidos por embalador (barras horizontais), rosca por logística e rosca por loja.
- **Tabelas**: performance por embalador (pedidos, envios, tempo total, média/pedido), produtos embalados (top 30, com pedidos e unidades) e erros do período (resumo por tipo + as 30 ocorrências mais recentes).
- **PDF**: botão "Baixar PDF" monta um HTML próprio (A4 retrato, tema claro) e chama `window.print()` numa aba nova — mesmo padrão do DRE e de Recebíveis, sem biblioteca de PDF. Os gráficos entram como PNG gerado **fora da tela** com `chart.toBase64Image()`: a mesma fábrica de configs (`rdConfigs`) serve tela e papel, só trocando o tema (`RD_TEMA.escuro` / `RD_TEMA.claro`) — assim não existem duas implementações do gráfico pra manter em sincronia. Como o canvas do Chart.js é transparente, um plugin (`rdFundoBranco`) pinta o fundo antes de exportar, senão o gráfico sairia invisível no papel. Exige pop-up liberado (avisa se estiver bloqueado).
- **Tempo médio é SUM/SUM**, nunca média das médias — mesmo critério do card da Conferência do Dia (um envio com 5 pedidos pesa mais que um com 1). Só entram no divisor os envios que têm duração gravada.
- **Papel `embalagem` tem acesso**: a rota está sob `/api/embalagem`, já liberada pelo gate (ver `auth-staff.md`).

## Alerta de gravação anormal (aba Bipar)

Enquanto grava, um timer ao lado do badge de status (`#scanTimer`, atualizado a cada 1s via `setInterval` em `startDurationWatcher()`) mostra o tempo decorrido — feedback visual contínuo, não só no final.

- **Curta demais** (`MIN_RECORDING_SECONDS = 5`): ao bipar de novo pra finalizar, se passou menos de 5s desde que a gravação começou, `finalizeCurrent()` mostra um `confirm()` perguntando se não foi um bipe duplo sem querer. Cancelando, **nada é interrompido** — a gravação atual continua rodando normalmente (`finalizeCurrent()` devolve `false` nesse caso; o chamador em `handleScan()`, no fluxo de trocar de etiqueta no meio de uma gravação, checa esse retorno antes de iniciar uma sessão nova — sem isso, um `MediaRecorder` antigo ficaria rodando escondido por trás de um novo).
- **Longa demais** (`MAX_RECORDING_SECONDS = 600`, 10min): passado esse tempo, um aviso persistente aparece acima da lista de pedidos (`#durationWarn`, não é o `showScanMsg()` normal que some sozinho em 6s) — fica visível até a gravação ser finalizada, pra não deixar passar despercebido que a câmera pode ter ficado ligada à toa.

Os dois limiares são constantes no topo do `<script>` de `pages/embalagem.html`, ajustáveis se a operação real mostrar que os valores (5s/10min) não fazem sentido.

## Estação única ML + Shopee (v35)

A mesma página `embalagem.html` atende ML e Shopee — o operador bipa qualquer etiqueta e a tela resolve sozinha qual marketplace é.

- **Detecção pelo formato do que foi bipado** (`parseShippingId`): QR/JSON do ML → `shipping_id` (11 dígitos, como antes); string `^BR[0-9A-Z]{8,}$` (ex.: `BR269090120689K`) → é o **rastreio** do QR da etiqueta Shopee, preservado como veio (não vira "só dígitos"). Fallback continua "só dígitos" pro barcode linear do ML.
- **Lookup** (`GET /api/embalagem/pedido/:key`): tenta `orders.shipping_id` (ML) primeiro; se vazio, casa por `shopee_order_data.tracking_number` (Shopee) e expande o `item_list` do `raw_data` em cards no mesmo shape do ML (`lookupShopeeByTracking`). A resposta traz `marketplace` (`ML`/`SHOPEE`).
- **Auto-busca de rastreio Shopee sob demanda** (`refreshShopeeTrackingOnDemand`): o `tracking_number` Shopee só é gravado pela sincronização de 15 min (e só quando o pedido fica `SHOPEE_SHIPPABLE`). Se o operador embala um pedido **recém-preparado** antes disso, o bipe não acharia (404). Pra evitar: quando o lookup falha em ML **e** em Shopee **e** o código não é `shipping_id` ML (regex `^\d+$` — numérico puro), a rota puxa o `get_tracking_number` na hora dos pedidos Shopee recentes (< 20 dias) ainda sem rastreio, atualiza `shopee_order_data.tracking_number` e **para assim que casa o código bipado** (ordena por mais recente, então o recém-preparado vem 1º). Usa `getShopeeClientForStore` (mesmo client/refresh do worker). É a única exceção em que uma rota de leitura da Embalagem chama a API de marketplace — justificada porque é ação de bipagem em tempo real, não listagem. Backfill manual em massa continua sendo `server/backfill-shopee-tracking.js`.
- **Foto**: no Shopee prioriza a foto da variação (`shopee_item_data.models` → `tier_variation[0].options[].picture.image_url` pelo `model_id`); fallback pra foto principal em `item_list[].image_info.image_url` (a resposta de `get_order_detail` já traz) — não depende de sync de catálogo, mas enriquecida quando o catálogo foi sincronizado.
- **Comprador**: `null` no Shopee (dado sensível — app sem acesso); os demais campos (item, quantidade, variação, valor) vêm normalmente.
- **Vídeo/gravação/busca/histórico**: 100% reaproveitado — o `packing_videos.shipping_id` guarda o valor bipado (shipping_id do ML **ou** tracking da Shopee) na mesma coluna, e `order_ids` guarda o `order_sn`. Nenhuma rota nova além da generalização do lookup.
- Um **badge "Shopee"** (`.emb-mp-badge`) aparece no título do card quando é Shopee, pro operador saber a origem.
- **Filtro por marketplace nas buscas**: as abas Buscar vídeos, Conferência do Dia e Histórico ganharam um select **Marketplace** (Todos/Mercado Livre/Shopee). O `GET /videos`/`/por-hora`/`/historico` aceitam `marketplace` (código `ML`/`SHOPEE`), derivado da loja do vídeo (`packing_videos.store_id` → `stores.marketplace_id` → `marketplaces.code`, `COALESCE` pra `ML` quando nulo). Cada linha da lista mostra um mini-badge ML/Shopee (`videoRowHtml`). O dropdown de **loja** continua listando só contas ML (`DB.getLojas` é ML-only); pra ver só Shopee, use o filtro de marketplace.
- **Variação/tipo em letra grande**: `.emb-order-tag` foi aumentada (30px, uppercase, além do piscar `.attention`) — pedido do usuário, vale pros dois marketplaces, é o dado que mais causa erro de embalagem.

## Rótulo de embalagem em PDF — 10x15cm com QR code (v46)

**Fluxo**: após vídeo gravado + upload bem-sucedido (`POST /finalizar`), o sistema exibe um modal de confirmação mostrando um preview com:
- **QR code** contendo o `shipping_id` (rastreabilidade: basta escanear pra recuperar a embalagem)
- **Nome da loja** (loja responsável pela embalagem)
- **SKU** (código único do item — crítico pra auditoria contra item errado)
- **Nome do produto** 
- **Tipo/Variação** (Cor/Tamanho, se houver)
- **Aviso "⚠ PRODUTO FRÁGIL"** (vermelho, destacado)
- **Data/Hora** de embalagem (timestamp em formato brasileiro)
- **Rodapé**: "PRODUTO EMBALADO PELA [EMPRESA]" (configurável, padrão "EMPRESA XYZ")

Ao confirmar, o navegador dispara um download automático (`etiqueta-{shipping_id}.pdf`). O usuário pode então:
- Imprimir em impressora térmica local (10x15cm é o tamanho padrão, basta configurar o papel)
- Imprimir em impressora comum A4 (o PDF se adapta)
- Visualizar no arquivo antes de imprimir

**Implementação**:
- `server/src/thermal/pdfLabel.js` — novo módulo que gera PDF de 10x15cm (283.46 × 425.19 pontos a 72 DPI) usando `pdfkit` + `qrcode`.
- `POST /api/embalagem/print-label` — rota que recebe `{ shipping_id, product_name, variation_type, sku, store_name, company_name }` e retorna PDF como blob com headers `Content-Type: application/pdf` e `Content-Disposition: attachment`.
- `pages/embalagem.html` — função `confirmAndSendPrint()` chamada após click em "Confirmar Impressão" no modal, trata resposta como blob e dispara download automático via `createElement('a').click()`.
- Dependencies: `pdfkit@^0.14.0` (adicionado a `package.json`)

**Decisões de design**:
- **PDF em vez de impressora térmica direta**: evita complexidade de infraestrutura (proxy, rede, driver). O embalador controla como/onde imprimir.
- **Preview antes de confirmar**: o modal mostra os dados que serão impressos (nome, SKU, variação, loja) — o operador pode cancelar se algo estiver errado, sem gerar PDF.
- **Auto-download**: depois de confirmar, o PDF já começa a baixar (não precisa de confirmação adicional no navegador); a tela retorna ao estado pronto pra bipar a próxima etiqueta.
- **Dados extraídos do pedido**: variação, SKU, nome e loja vêm de `session.orders[0]` (já carregado no frontend) + metadados da loja (`stores.nickname`), sem chamada extra à API.
- **Sem estoque de papel**: não há limite operacional de impressões como havia com impressora térmica em rede — cada PDF é um arquivo, qualquer quantidade de cópias sem custo adicional.

**Configuração** (mínima):
- Nenhuma variável de ambiente necessária no `.env` — basta ter `pdfkit` instalado.
- Se desejar customizar `company_name` por loja, a coluna já existe em `stores` (padrão "EMPRESA XYZ" é fallback no código).

## O que NÃO foi implementado (fora de escopo desta fase)

- Backfill de `shipping_id` para pedidos antigos.
- Suporte a múltiplas câmeras/seleção de dispositivo — usa a câmera padrão do navegador (`getUserMedia` sem `deviceId`).

## Relatório de erros (v65)

Toda falha ao salvar o vídeo de conferência (`POST /finalizar`) é registrada em `embalagem_errors` por `logEmbalagemError` (nunca lança): upload/disco (`uploadVideo` embrulha o multer e captura `LIMIT_FILE_SIZE`/erro de disco), arquivo ausente, `shipping_id` faltando, ou falha no INSERT em `packing_videos`. O arquivo em disco (a gravação real) NÃO é apagado numa falha de banco — o `file_path` é logado pra recuperação manual. Aba **"Erros"** na página (`GET /embalagem/erros?days`) lista tipo, pedido(s), loja, embalador e data/hora; badge vermelho no topo mostra a contagem. Ao falhar um salvamento, o front mostra a mensagem apontando pra aba e atualiza o badge.
