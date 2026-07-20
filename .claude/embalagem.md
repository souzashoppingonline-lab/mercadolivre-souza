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

**Pedidos antigos** (criados antes da v21) não têm `shipping_id` retroativo — só pedidos processados a partir do deploy desta migration. Um backfill retroativo (buscar `/orders/:id` de novo pra pedidos antigos só pra extrair o `shipping_id`) não foi feito — mesma classe de decisão já tomada pro backfill de `shipping_type` (ver `decisions.md`), fora de escopo por enquanto.

## Fluxo da tela (`pages/embalagem.html`)

Quatro abas: **Bipar** (fluxo principal), **Buscar vídeos** (consulta livre), **Conferência do Dia** (consulta sempre travada em "hoje") e **Histórico** (tendência ao longo de semanas/meses).

### Aba Bipar — máquina de estado

`idle → loading → recording → saving → idle` (com uma bifurcação de confirmação).

1. **Idle**: campo de bipagem sempre em foco (reforça foco automaticamente ao clicar fora de campos de texto). Câmera já ligada em preview (pedida a permissão assim que a página carrega, via `getUserMedia({video:true,audio:true})`) — assim quando o pedido for identificado, a gravação começa sem precisar de novo popup de permissão.
2. **Bipa** → `parseShippingId()` extrai o `shipping_id` → `GET /api/embalagem/pedido/:shippingId`. Não achou → mensagem de erro, volta pra idle (não inicia gravação nenhuma). **Achou, mas já tinha sido embalado antes** (`already_packed` no payload — a rota já checa `packing_videos` pelo mesmo `shipping_id`, pega o registro mais recente) → `confirm()` avisando quando foi embalado, perguntando se quer gravar de novo mesmo assim; cancelando, não inicia gravação. Confirmando (ou se nunca foi embalado), segue pro passo 3 — e nesse caso um aviso fica visível acima do card enquanto grava, não é só um popup que passa despercebido.
3. **Achou** → mostra na tela, num card grande, todos os pedidos daquele envio (pode ser mais de um — "pack"): imagem (180px), título grande, **quantidade em destaque bem maior que o resto** (pedido explícito do usuário — é o dado mais importante pro embalador conferir), variação (cor/tamanho, se houver) como tags, comprador, e uma grade de detalhes — SKU, valor (`unit_price × quantity`), logística (`shipping_type` formatado com a mesma função `logLabel()` de `top-vendas-online.html`), status do pedido, data/hora da venda, e estoque atual do item (`items.available_quantity`, destacado em vermelho se `≤ 5`). **Todos esses campos já vêm do Postgres** (`orders.raw_data` pra SKU/variação, sem nenhuma chamada nova à API do ML). `MediaRecorder` começa a gravar nesse instante.
4. **Bipa de novo enquanto grava**:
   - Se for a **mesma** etiqueta → entende como "terminei", para a gravação (rápido, `MediaRecorder.stop()`, não depende de rede) e sobe o vídeo em segundo plano (`uploadPackingVideo()`, `POST /api/embalagem/finalizar` multipart, **sem `await`**) — o operador já pode bipar a próxima etiqueta imediatamente, não espera o upload terminar. Se o upload falhar, uma mensagem de erro aparece depois (mesma `showScanMsg`), mesmo que o operador já tenha ido pra outro pedido. Tela de "Pedido embalado" fica visível só 2s antes de voltar pro estado pronto pra bipar (era 10s — atrapalhava o ritmo do embalador). Ver `decisions.md`.
   - Se for uma etiqueta **diferente** → per pedido explícito do usuário, **pergunta antes** (`confirm()` nativo: "Você bipou uma etiqueta diferente da que está em gravação... Deseja finalizar a atual e começar uma nova?"). Confirmando, finaliza a gravação atual normalmente e já inicia a nova; cancelando, ignora o bipe novo e a gravação em andamento continua intacta.
5. Vídeo salvo com sucesso → mensagem grande de 2 linhas ("✅ Pedido embalado com sucesso" / "Pode seguir para o próximo pedido", `showBigSuccessMsg()`), visível por 2s antes de voltar pra idle sozinho (texto exato pedido pelo usuário).

### Destaque piscante em quantidade e variação (card do pedido)

Pedido explícito do usuário, com print mostrando o card real: quantidade ("1 un.") e a tag de variação ("TIPO: PEIXE") passavam despercebidas pro embalador numa olhada rápida, mesmo já sendo os dados mais importantes pra conferir (quantidade já tinha destaque de tamanho de fonte antes — ver passo 3 do fluxo acima — mas não bastava). Solução: animação CSS de piscar (`@keyframes embQtyBlink`/`embTagBlink`, mesmo padrão do `@keyframes embPulse` já usado no indicador de gravação), aplicada via classe `.attention` em `.emb-order-qty` e em cada `.emb-order-tag` — puro CSS, sem lógica condicional nem novo dado do backend, sempre piscando enquanto o card está na tela. `embQtyBlink` pulsa um glow amarelo (`drop-shadow`) + leve zoom (`scale`); `embTagBlink` inverte fundo/texto da tag (de discreta pra amarelo sólido com sombra) — ambos ciclo de 0.9s.

**Seta piscante apontando a quantidade**: pedido de acompanhamento, com print mostrando uma seta desenhada à mão apontando pra "1 un." — o piscar sozinho (acima) não deixava óbvio *o quê exatamente* olhar. Ícone Font Awesome (`fa-arrow-left`) ao lado do número, dentro de um wrapper `.emb-qty-row` (`display:flex`, número + seta na mesma linha), com `@keyframes embArrowBlink` fazendo a seta "cutucar" o número — some/aparece (`opacity`) e desliza alguns pixels em direção à quantidade (`translateX(-10px)`) a cada ciclo de 0.8s. Cor vermelha (`var(--red)`), contrastando com o amarelo do número, pra parecer uma seta de "está aqui" e não se confundir com o resto do destaque amarelo.

### Aba Buscar vídeos

Filtros: nº do pedido, comprador, data de/até (`GET /api/embalagem/videos`). Resultado: lista com título/comprador/loja/data/duração + botão "Assistir", que abre um modal com `<video controls>` apontando pra `GET /api/embalagem/videos/:id/file` (Express `res.sendFile` já suporta `Range`, então dá pra avançar/voltar no vídeo sem baixar ele inteiro).

### Aba Conferência do Dia

Mesma listagem/mesmo modal de vídeo da aba anterior (`videoRowHtml()` compartilhada entre as duas — sem duplicar o template). **Sempre abre no dia de hoje** (o campo `Data` é preenchido com a data atual só na 1ª carga, via `todayISO()`) — objetivo é servir de checklist rápido de fim de expediente: "o que já foi bipado hoje" — mas o campo é editável, dá pra trocar pra outro dia se precisar. Filtros: nº do pedido, data, loja (dropdown populado via `DB.getLojas()`, mesmo padrão da Agenda Trello) e comprador. Recarrega automaticamente toda vez que a aba é aberta. **Não tem estado de "conferido"/"revisado" persistido** — é só listagem e filtro (decisão explícita do usuário, mantém o escopo simples sem coluna nova no banco).

**Cards de resumo** (`renderConfKpis()`), acima da lista de vídeos: total bipado no dia/filtro selecionado, contagem por tipo de logística (Flex/Mercado Envios, mesma classificação de `logLabel()`) e um card por loja com pelo menos 1 vídeo no período. Tudo calculado **no frontend**, em cima da mesma resposta de `GET /api/embalagem/videos` que já popula a lista — nenhuma rota nova, nenhuma query extra. Único ajuste de backend: a rota `GET /videos` passou a devolver também `sample_shipping_type` (join `LATERAL` já existente com `orders`, só mais uma coluna no `SELECT`).

**Cards são clicáveis** (`openConfDrill()`): clicar em qualquer um (Bipados/Flex/Mercado Envios/uma loja) abre um modal listando só os pedidos daquela fatia (`videoRowHtml()`, mesmo template da lista principal, com botão "Assistir" que abre o vídeo por cima). Filtro é feito em `confRows` (array já carregado em memória, guardado em `loadConferenciaDia()`) — nenhuma chamada nova ao backend por clique.

**Card "Tempo médio / pedido"**: usa o `duration_seconds` que `packing_videos` já grava (é literalmente o tempo de gravação — da identificação do pedido até bipar de novo pra finalizar, ver "Fluxo da tela" acima) e `order_ids` (quantos pedidos aquele envio agrupa). Fórmula: `SUM(duration_seconds) / SUM(quantidade de pedidos por envio)` — soma total dividida por soma total, não "média das médias", pra um envio de 5 pedidos pesar mais que um de 1 pedido só no cálculo. **Decisão explícita do usuário**: a métrica é por **pedido** (`orders.ml_id`/`order_ids`), não por item — um pedido com 2+ itens dentro continua contando como 1 pedido, sem dividir pela quantidade. Vídeos sem `duration_seconds` (ex: upload que falhou antes de mandar essa info) são ignorados no cálculo, não entram como zero.

**Gráfico de colunas "por hora"** (`renderConfHourChart()`, Chart.js — mesma lib já usada em `top-vendas-online.html`/`analise-vendas-mes.html`): compara a quantidade de bipagens por hora (0-23) do dia selecionado com o dia imediatamente anterior, mesmo filtro de loja se houver. Usa a rota dedicada `GET /api/embalagem/por-hora?date&store_id` (não dá pra calcular isso em cima de `GET /videos` porque ela tem `LIMIT 100` e só cobre 1 dia por chamada) — a rota devolve sempre as 24 horas (zero-fill via `generate_series(0,23)` + `LEFT JOIN`), pra o eixo do gráfico nunca ter buraco mesmo em horas sem nenhuma bipagem.

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

## Alerta de gravação anormal (aba Bipar)

Enquanto grava, um timer ao lado do badge de status (`#scanTimer`, atualizado a cada 1s via `setInterval` em `startDurationWatcher()`) mostra o tempo decorrido — feedback visual contínuo, não só no final.

- **Curta demais** (`MIN_RECORDING_SECONDS = 5`): ao bipar de novo pra finalizar, se passou menos de 5s desde que a gravação começou, `finalizeCurrent()` mostra um `confirm()` perguntando se não foi um bipe duplo sem querer. Cancelando, **nada é interrompido** — a gravação atual continua rodando normalmente (`finalizeCurrent()` devolve `false` nesse caso; o chamador em `handleScan()`, no fluxo de trocar de etiqueta no meio de uma gravação, checa esse retorno antes de iniciar uma sessão nova — sem isso, um `MediaRecorder` antigo ficaria rodando escondido por trás de um novo).
- **Longa demais** (`MAX_RECORDING_SECONDS = 600`, 10min): passado esse tempo, um aviso persistente aparece acima da lista de pedidos (`#durationWarn`, não é o `showScanMsg()` normal que some sozinho em 6s) — fica visível até a gravação ser finalizada, pra não deixar passar despercebido que a câmera pode ter ficado ligada à toa.

Os dois limiares são constantes no topo do `<script>` de `pages/embalagem.html`, ajustáveis se a operação real mostrar que os valores (5s/10min) não fazem sentido.

## Estação única ML + Shopee (v35)

A mesma página `embalagem.html` atende ML e Shopee — o operador bipa qualquer etiqueta e a tela resolve sozinha qual marketplace é.

- **Detecção pelo formato do que foi bipado** (`parseShippingId`): QR/JSON do ML → `shipping_id` (11 dígitos, como antes); string `^BR[0-9A-Z]{8,}$` (ex.: `BR269090120689K`) → é o **rastreio** do QR da etiqueta Shopee, preservado como veio (não vira "só dígitos"). Fallback continua "só dígitos" pro barcode linear do ML.
- **Lookup** (`GET /api/embalagem/pedido/:key`): tenta `orders.shipping_id` (ML) primeiro; se vazio, casa por `shopee_order_data.tracking_number` (Shopee) e expande o `item_list` do `raw_data` em cards no mesmo shape do ML (`lookupShopeeByTracking`). A resposta traz `marketplace` (`ML`/`SHOPEE`).
- **Foto**: no Shopee vem de `item_list[].image_info.image_url` (a resposta de `get_order_detail` já traz) — não depende de sync de catálogo.
- **Comprador**: `null` no Shopee (dado sensível — app sem acesso); os demais campos (item, quantidade, variação, valor) vêm normalmente.
- **Vídeo/gravação/busca/histórico**: 100% reaproveitado — o `packing_videos.shipping_id` guarda o valor bipado (shipping_id do ML **ou** tracking da Shopee) na mesma coluna, e `order_ids` guarda o `order_sn`. Nenhuma rota nova além da generalização do lookup.
- Um **badge "Shopee"** (`.emb-mp-badge`) aparece no título do card quando é Shopee, pro operador saber a origem.
- **Variação/tipo em letra grande**: `.emb-order-tag` foi aumentada (30px, uppercase, além do piscar `.attention`) — pedido do usuário, vale pros dois marketplaces, é o dado que mais causa erro de embalagem.

## O que NÃO foi implementado (fora de escopo desta fase)

- Backfill de `shipping_id` para pedidos antigos.
- Suporte a múltiplas câmeras/seleção de dispositivo — usa a câmera padrão do navegador (`getUserMedia` sem `deviceId`).
