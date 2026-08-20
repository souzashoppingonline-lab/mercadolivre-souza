# Análise de Produtos

Módulo de **decisão de compra**: cadastra um produto (com custos reais), coleta
anúncios concorrentes do Mercado Livre via **extensão Chrome**, e (fases futuras)
cruza tudo com IA pra dizer se vale vender, preço ideal, margem e volume.

Construído em **fases** (evita virar um monstro):
- **Fase 1 (feita):** cadastro de produto + custos, fila de "produto ativo para
  coleta", página com tabela + modal + tela do produto com cards ao vivo (WS).
- **Fase 2 (futuro):** inteligência de preço/concorrência + mapa geográfico +
  simulador preço×lucro (usa as fórmulas de `finance.md`), tudo cálculo, sem IA.
- **Fase 3 — NÚCLEO (feito):** motor de IA com Score do Produto (0-100) + 3 agentes
  de maior valor — **Comentários** (reclamações/elogios/oportunidades), **Financeiro**
  (custo, preço sugerido, margem líquida, lucro/un.) e **Decisão** (VALE/ATENÇÃO/
  NÃO_VALE + riscos + próximos passos). Uma única chamada estruturada (JSON), barata.
- **Fase 3 — resto (futuro):** os outros 6 agentes (mercado, comercial, marketing,
  perguntas, criativos, SEO). O **SEO por contagem** (palavras-chave que se repetem
  nos títulos dos concorrentes) já está feito **sem IA** — ver seção própria abaixo;
  o agente de SEO seria a camada de redação em cima dessa lista.

## Fluxo (o pulo do gato)

Cadastrar → produto fica `EM_ANALISE` → **ativar coleta** (vira o único "produto
ativo") → a **extensão consulta a API** e sabe pra qual produto enviar (nunca
pergunta ao usuário) → cada anúncio coletado vira um card na hora (WebSocket) →
**Finalizar coleta** (limpa o ativo) → **Analisar** (Fase 3).

## Banco (v50)

- `analise_products` — produto, fornecedor, preco_compra, taxa_mp (%), imposto (%),
  frete_entrada (R$), embalagem (R$), observacoes, status (`EM_ANALISE`/`ANALISADO`).
- `analise_product_ads` — anúncio concorrente coletado (FK product_id, `UNIQUE
  (product_id, ml_id)` pra dedup). `is_full`/`is_flex` (não `full`/`flex` —
  palavra reservada no Postgres); a API devolve como `full`/`flex`. `observacoes`
  (anotação livre), `comentarios_texto` (comentários colados p/ a IA) e `raw`
  (payload cru completo da extensão).
- `analise_active_collection` — linha única (id=1) apontando o produto ativo de
  coleta. É daqui que a extensão lê o alvo.

## API

**Dashboard (staff, `/api/analise`)** — `routes/analise.js`:
- `GET /produtos` → lista + `ativo_id` + `anuncios_count`.
- `GET /produtos/:id` → produto + anúncios + `ativo_id`.
- `POST /produtos` → cadastrar. `POST /produtos/:id/editar` → editar.
- `POST /produtos/:id/ativar` → define como único ativo de coleta.
- `POST /produtos/:id/finalizar` → limpa o ativo.
- `POST /produtos/:id/analisar` → **motor de IA (Fase 3 núcleo)**. Roda Score +
  Comentários + Financeiro + Decisão sobre os concorrentes coletados, grava
  `ai_result`/`ai_score`/`ai_analyzed_at` no produto (status→`ANALISADO`) e devolve
  `{result, score, produto}`. **Síncrono** (a página mostra spinner). 503 se a chave
  de IA não estiver configurada; 400 se não houver concorrente coletado.
- `POST /produtos/:id/anuncio` → **adiciona concorrente à mão** (publica WS `analise_anuncio`).
- `POST /anuncios/:adId/editar` → completa/corrige campos que a extensão não pegou (ex.: comentários, nota). `fotos` só sobrescreve se vier nova.
- `POST /anuncios/:adId/excluir` → remove um card.

O anúncio tem `observacoes` (v51) pra anotar à mão o que a extensão não capturou. `is_full`/`is_flex` no banco viram `full`/`flex` na API via `mapAd`. **`descricao` (v61)**: descrição do anúncio, capturada pela extensão (`rawData.extracted.description`) e salva por `ads.js`; aparece num `<details>` no card e no payload da IA.

**`highlights` (v62)**: bullets "O que você precisa saber sobre este produto",
capturados pela extensão (`extracted.highlights`), salvos como JSONB por `ads.js`
e mostrados num `<details>` no card.

**Gráfico de preços no card (v61):** botão 📈 no card (`abrirGraficoPreco`) abre um **modal** com gráfico de linha SVG (`bigChart`) do histórico de preço coletado (`anuncio.monitor.historico`) — sem expandir o card. Só leitura do que já vem no `GET /produtos/:id`.

**Comentários — dois campos separados:**
- `comentarios_auto` (v53) — os comentários VISÍVEIS que o extrator (`extractCommentsText`) recorta da seção "Opiniões" do `pageText`. **A extensão preenche sozinha** e atualiza a cada recoleta.
- `comentarios_texto` (v52) — só do operador: os comentários antigos (que o ML esconde atrás de "Mostrar todas as opiniões"), colados à mão. **A extensão nunca toca** neste campo.

São colunas distintas de propósito, pra a coleta automática não sobrescrever o que o operador colou. Ambos são texto cru (a IA da Fase 3 lê e agrupa reclamações/elogios) e distintos de `comentarios`, que é só a contagem numérica.

### Vendas reais (Shopping de Preço, v57)

Campos preenchidos **à mão** no card do concorrente: unidades vendidas e preço médio praticado em **7/15/21/30 dias** (`vendas_7d`/`preco_medio_7d`, …, `vendas_30d`/`preco_medio_30d`). Vêm da ferramenta externa "Shopping de Preço" (que só mostra anúncios com >US$300 vendidos, logo categorias novas podem não ter — deixa-se em branco). É o dado **mais relevante** pra decisão: `buildContext` inclui um objeto `vendas_reais` por concorrente (só as janelas preenchidas) + flag `tem_vendas_reais`, e o prompt manda a IA dar **PESO MÁXIMO** — usar as unidades pra dimensionar demanda e o preço médio pra ancorar o preço sugerido no valor realmente praticado; sem esses dados, ser mais conservadora. A extensão nunca sobrescreve (upsert com COALESCE).

**Extensão — card "Você recebe" (estimado, v1.1.0, só no painel, não vai pro banco):** como o concorrente não expõe tarifa/frete reais, a extensão estima no painel: `tarifa = preço×comissão% + custo fixo` (R$6,75 para preço < R$79) e `frete` = o que o vendedor paga (só quando detecta "frete grátis" na página, via `extractFreteGratis`). `você recebe = preço − tarifa − frete`. **Comissão% e frete são editáveis** e salvos em `chrome.storage.local` (`fe_calc`), porque variam por categoria/tipo de anúncio — recalcula ao vivo. É ferramenta de leitura rápida, não persiste no dashboard.

**Extensão (público, `routes/extensionAnalise.js`, montado em `/extension` antes do gate):**
- `GET /extension/produto-ativo` → `{produto: {id, produto, status}|null}`.
- `POST /extension/anuncio` → grava no produto ATIVO (o servidor resolve; 409 se
  nenhum). Aceita `rawData` (HTML/pageText/jsonLd → o servidor extrai via
  `extractors/mercadolivre.js`) e faz **upsert por `ml_id`** (recoleta atualiza, não
  duplica). Publica WS `analise_anuncio`. A gravação usa o módulo compartilhado
  `server/src/analise/ads.js` (`upsertAd`), o mesmo do add manual.

## WebSocket

Tópico `analise_anuncio` (payload `{produto_id, anuncio}`) — publicado quando a
extensão salva um anúncio; a página insere o card sem recarregar. Mesmo padrão do
`print:{station_id}`.

## Frontend

`pages/analise-produtos.html` (menu Análises). Duas telas: lista (tabela + "Novo
Produto") e detalhe (header + cards de concorrentes ao vivo + Ativar/Finalizar
coleta + Analisar). Métodos em `js/db.js` (`getProdutosAnalise`, `criarProdutoAnalise`,
`ativarColetaProduto`, etc.).

## Coleta automática de concorrentes (v66 / extensão v1.2.0)

**Problema:** a coleta era 100% manual — abrir cada anúncio de concorrente e clicar "Salvar na análise" todo dia era inviável. **Solução:** monitoramento automático em background, sem clique, com o Chrome aberto.

**Arquitetura (padrão MV3 correto — a inteligência sai do popup e vai pro Service Worker):**
- **Watchlist = a própria `analise_product_ads`** (os concorrentes já cadastrados por produto). Migration v66 só adicionou `last_checked_at` + índice `idx_analise_ads_monitor_check`.
- **Backend** (`extensionAnalise.js`): `GET /extension/monitoramento/proximos?limit=N` devolve os concorrentes mais desatualizados (`last_checked_at` nulo ou > 24h → **recoleta 1×/dia**), dedup por `ml_id`; `POST /extension/monitoramento` casa pelo `ml_id` e atualiza o anúncio em **todos** os produtos onde ele é monitorado, carimba `last_checked_at`, alimenta `analise_monitor_snapshots` — **não depende do produto ativo** (fluxo paralelo ao `/anuncio` manual, que segue existindo). O helper `resolveAdPayload()` é compartilhado pelos dois.
- **Service Worker** (`service-worker.js`): `chrome.alarms` a cada 15 min → `runMonitorCycle()`: `GET /proximos` → abre cada anúncio numa **aba oculta** (`tabs.create({active:false})`), espera carregar, pede `auto_capture` ao content script, `POST /monitoramento`, **fecha a aba**. Pool de no máx. **3 abas simultâneas** (`processQueue`), config em `chrome.storage.local` (`monitorEnabled`, `batchSize=5`, `maxTabs=3`, `tabTimeoutMs`). Idempotente: se o SW morre no meio, o próximo alarm re-busca os que ainda estão desatualizados (estado no banco, não na memória).
- **Content Script**: listener `auto_capture` → `autoCapture()` espera o anúncio "amadurecer" (MLB + preço, até ~8s) e responde com o **mesmo `rawData`** da coleta manual (`collectAll()` reusado). O painel/botão manual continua intacto.
- **Popup**: vira status ("último ciclo: X ok / Y falhou", botões "Sincronizar agora" e "Pausar/Ativar"). Nenhuma lógica de coleta nele.

**Ligar/desligar (o "até que eu desligue"):** **"Finalizar coleta"** agora também **desliga o monitoramento** dos concorrentes daquele produto (`monitorar=false` em massa); **"Coleta ativa"** religa (`monitorar=true`). Por anúncio há um **toggle** no card (`POST /analise/anuncios/:adId/monitorar`, botão `.mon-tgl` verde=monitorando / cinza=pausado) pra manter só alguns. O `/proximos` só entrega quem tem `monitorar=true`. **Robustez:** o carimbo `last_checked_at` no `/anuncio` é best-effort (`stampChecked`) — se a migration v66 não rodou, a coleta manual **não quebra** (só não carimba).

**Limites (inerentes, documentados):** só roda com **Chrome aberto e logado**; vai devagar (3 abas, N por ciclo) pra não parecer robô pro ML; "vendidos" do concorrente é aproximado (o ML mostra faixa). É a diferença de extensão vs. worker no servidor — concorrente **exige** carregar a página (ML dá 403 na API de terceiro). Ver `decisions.md`.

## Extensão Chrome (`chrome-extension/`)

**v2 — painel DARK na página (estilo Metrizap).** `content.js` detecta página de
anúncio (MLB no path ou JSON-LD de Produto) e injeta um **card fixo escuro** no
canto, preenchido com o que dá pra extrair da própria página: título, preço
(+ original/% OFF), **loja + medalha** (Platinum/Gold/Silver, encurtada de
"MercadoLíder X"), **cidade/estado**, **data de criação** (de "Publicado há X
dias" ou do `date_created`/`start_time` embutido nos scripts do ML), avaliação,
estoque, vendas e MLB. Botões: **Salvar na análise** (fluxo antigo —
`collect_data` → `service-worker` → `POST /extension/anuncio`, grava no produto
ativo), **Baixar fotos** e **Baixar vídeos**.

- **Download de mídia**: `content.js` junta as URLs de fotos (JSON-LD `image` +
  galeria do DOM, elevadas a alta-res via `hiRes`) e vídeos (JSON-LD `video`,
  `<video src>`, links YouTube) e manda pro `service-worker`, que usa
  `chrome.downloads` (permissão nova no manifest) pra baixar cada uma em
  `financeecom/<MLB>/`. YouTube abre em aba (não é baixável direto).
- **v2.1 (ajustes do teste):** painel maior (360px, fontes maiores); **minimizar
  → ícone flutuante** no canto (`#fe-launcher`) que reabre; extração de loja e
  cidade/estado reforçada (via `pageState()` — texto dos `<script>` embutidos, +
  `uf()` pra sigla); **seguidores/produtos** de loja oficial; **botão copiar MLB**;
  seções `<details>` **"O que você precisa saber"** (highlights) e **Descrição**.
  Tudo extraído vai também no payload de "Salvar na análise" (`rawData.extracted`).
- **v2.2 (pacote Demanda):** o painel ganhou:
  - **📈 Demanda estimada** (card): vendas/dia = vendidos ÷ dias no ar, projeção/mês
    e "estoque acaba em ~Nd" (estoque ÷ vendas-dia). "Vendidos" é piso → mostra ≥.
  - **❓ Perguntas** (últimas + contagem) — dúvidas/objeções reais dos clientes.
  - **🎨 Variações** (total + quantas esgotadas = demanda não atendida).
  - **🏆 Catálogo** (nº de vendedores + menor preço, quando é anúncio de catálogo).
  - **🔧 Ficha técnica** (marca/modelo/GTIN).
  - **📉 Histórico de preço** (mini-gráfico): `content.js` busca
    `GET /extension/monitor/:mlb` (snapshots v58 do servidor) e desenha a linha +
    "▼ X% em ~30d". Só aparece se o MLB já tiver histórico.
  Vídeo: só mp4 nativo do ML baixa; YouTube do anúncio só abre em aba.
- **v2.3 — localização correta:** o ML guarda geolocalização como
  `state:{id:"BR-SP",name:"São Paulo"}` / `city:{id:"BR-SP-31",name:"Osasco"}`.
  Antes o extrator pegava o `id` (mostrava "BR-SP-31, BR-SP"); agora pega o
  **name** da cidade e a **UF do código `BR-<UF>`** (cobre os 27 estados), devolve
  `{cidade, estado}`. A rota `/extension/anuncio` salva `extracted.location` em
  `cidade`/`estado`, e o **card** mostra um badge 📍 na linha de badges (visível
  sem abrir). Só preenche em anúncios recoletados pela extensão v2.3+.
- **Campos que NÃO entram** (fase seguinte): Frete/Tarifa/"você recebe" e as
  estimativas em faixa de visitas/vendas/faturamento (o ML esconde de terceiros).
  Cada linha do painel só renderiza se o valor existe — nada de campo vazio; tudo
  best-effort no HTML do ML (seletor pode precisar de ajuste quando o ML muda).

`popup.js` mostra o **produto ativo** (`GET /extension/produto-ativo`) — a
extensão nunca pergunta o alvo; o popup também é dark (v2). `manifest.json` tem
host_permission pro servidor + permissão `downloads`. Rota antiga
`/extension/collect` (`extensionCollect.js`) é legado.

Limite do body: `express.json({ limit: '1mb' })` (o pageText cabe; o innerHTML não
é enviado).

## SEO / palavras-chave dos concorrentes (v67)

Painel na tela do produto (`#seoPanel`, entre a análise de IA e os cards) que lê
**todos os concorrentes coletados** e devolve a lista dos termos que mais se
repetem. **100% no navegador**, a partir do que o `GET /produtos/:id` já trouxe —
sem rota nova, sem consulta, **sem custo de IA**. Recalcula sozinho a cada card
que entra (o `renderCards` chama `renderSeo()`, e o WS `analise_anuncio` passa
por ele).

- **Métrica que ordena: cobertura** — em quantos anúncios o termo aparece, não a
  repetição bruta. Palavra repetida 10× num anúncio só é vício daquele vendedor;
  a que está em 8 de 10 é o núcleo obrigatório do título. Faixas: **≥60% = núcleo**
  (verde, sai também em chips no topo), 30-59% comum no nicho, <30% diferenciação.
- **Fonte escolhível**: *só os títulos* (padrão — é o que ranqueia no ML) ou
  *títulos + destaques + descrição* (mais volume, mais ruído).
- **Palavras e frases**: conta unigramas, bigramas e trigramas. N-grama nunca
  começa nem termina em stopword (senão "de café com" viraria frase-chave), por
  isso frases ligadas por preposição aparecem como trigrama ("xícaras de café",
  "café com pires"). Termo presente em **um único anúncio é descartado** — não é
  padrão de mercado.
- **Tokenização**: minúsculas, pontuação fora, **número+unidade preservado**
  (`90ml`, `1,5l`, `10%` são palavra-chave de verdade no ML), token de 1 letra e
  número puro descartados. Agrupamento por forma **sem acento** (une
  "xícara"/"xicara") exibindo a grafia mais usada.
- **Saídas**: *Copiar núcleo* (só os ≥60%), *Copiar lista* (tudo, separado por
  vírgula, pronto pra colar) e **CSV** (termo, nº de palavras, anúncios, total,
  % de cobertura, ocorrências).
- Some com menos de 2 anúncios — não existe "o que se repete" com um só.

## Motor de IA (Fase 3 núcleo)

- `server/src/ai/llm.js` — cliente Anthropic compartilhado (Messages API, mesmo
  padrão que a IA Sócio Shopee usava inline). `isConfigured()` = há `ANTHROPIC_API_KEY`?
  `complete()`/`completeJson()`. **Sem chave, lança erro claro — nada de IA roda.**
- `server/src/ai/analiseAgents.js` — `buildContext(produto, anuncios)` monta o
  contexto REAL (custos + resumo compacto dos concorrentes + texto de comentários) e
  `analisarNucleo()` faz **uma** chamada JSON devolvendo `{comentarios, financeiro,
  decisao, score}`.
- **Custo mínimo por análise** (pedido do usuário): modelo Haiku (`AI_MODEL`),
  campos compactos, nº de concorrentes limitado (`ANALISE_MAX_ADS=10`) e teto do
  texto de comentários (`ANALISE_MAX_COMMENT_CHARS=3500`), `max_tokens` de saída 1200.
  Fica abaixo de ~1 centavo por clique. Ajustável por env sem deploy.
- Frontend: painel `#iaPanel` na tela do produto — anel de Score colorido, veredito,
  e 3 cards (Comentários/Financeiro/Decisão). Renderiza ao abrir o produto (lê
  `ai_result`) e após clicar "Analisar Produto".

### Gerador de Criativos (v55)

`gerarCriativos()` (em `analiseAgents.js`) faz **uma** chamada extra que devolve
**7 briefs de imagem em JSON** (schema `composicao`/`direcao_de_arte`/
`elementos_visual_copy`/`formato` + `objecao_quebrada`), cada um **quebrando uma
objeção** tirada dos comentários. Rota `POST /produtos/:id/criativos` (503 sem chave),
grava em `ai_creativos`/`ai_creativos_at`. É **on-demand** (botão "Gerar 7 criativos"
no painel) porque a saída é grande (`max_tokens` 4000) — mantém a análise barata. Na
tela cada JSON vem num bloco com botão **Copiar** pro usuário colar no ChatGPT (junto
das fotos do produto) e gerar a imagem.

## Monitoramento de concorrentes (v58)

Snapshot **diário** de cada MLB coletado, via API do ML (`server/src/analise/monitor.js`).
O **preço** é o foco; também guarda estoque, `sold_quantity` (+ `sold_delta` = vendas
do dia), visitas/dia, tipo de anúncio, frete e status. Tabela `analise_monitor_snapshots`
(1 linha por MLB por dia, UNIQUE `ml_id+snap_date`). O anúncio ganhou `link` e `monitorar`
(v58) — MLB e link viraram **editáveis à mão** (permite monitorar concorrentes manuais);
o MLB é extraído do link automaticamente se faltar (`mlbFrom` em `ads.js`).

- **Token**: usa o `access_token` de qualquer loja ML conectada (`pickMlStoreId`) — o ML
  exige token mesmo pra dados públicos.
- **Job diário**: `sync-monitor-analise` no `worker.js` (05:45), roda `snapshotAll()`.
- **On-demand**: botão "Monitorar agora" no detalhe → `POST /produtos/:id/monitorar-agora`
  (snapshot na hora de todos os MLBs do produto).
- **Na tela**: tudo **dentro do card** do concorrente — MLB + link, preço monitorado atual
  com Δ vs. dia anterior, mini-gráfico SVG de preço, estoque/vendas-dia/visitas/status e
  uma **tabela de preços** (últimos snapshots). O GET `/produtos/:id` já devolve
  `anuncio.monitor = {historico, ultimo, count}`.
- **Limite honesto** (ver known-bugs): o ML devolve **403 access_denied** ao ler item de
  concorrente via API pra este app. `fetchItem` tenta o multiget como fallback; e o
  histórico de preço é alimentado pela **extensão** (lê a página, funciona) via
  `recordSnapshot` a cada coleta — por isso o `upsert` do snapshot usa COALESCE (API =
  dados completos, extensão = só preço, sem se apagarem). `sold_quantity` às vezes vem
  arredondado/oculto; aí o Δ estoque e as visitas indicam a demanda.
- **Campos do Shopping de Preço (`vendas_Nd`/`preco_medio_Nd`) são EXCLUSIVAMENTE manuais**:
  nem a extensão, nem o botão "Puxar dados do ML", nem o snapshot os alteram (só o
  add/editar manual escreve neles).

## Alertas de mudança do concorrente (v60)

Camada de **aviso** por cima do snapshot: a v58 já guardava o histórico, mas não
avisava. Agora, toda vez que um snapshot é gravado (`recordSnapshot`), o
`detectAndAlert` compara o valor NOVO com o **último estado conhecido** e, se
cruzou um limiar, grava um alerta em `analise_monitor_alerts` **e dispara Telegram**.

- **4 gatilhos**: preço subiu/caiu (≥ `ANALISE_ALERT_PRICE_PCT`, padrão 3%),
  estoque zerou/voltou, anúncio pausou/encerrou (`status`), disparada de vendas
  (Δ vendas do dia ≥ `ANALISE_SALES_SPIKE_MIN`, padrão 15). Limiares em
  `business-rules.md`.
- **Só transição real dispara** (nunca a cada snapshot idêntico) e há **dedup**
  por `(ml_id, tipo, novo valor)` nas últimas 20h — o job diário e o "Monitorar
  agora" não avisam a mesma mudança duas vezes.
- **Telegram**: `tgNotifyForce('tg_monitor_analise', …)` (sem throttle; o dedup já
  evita spam). Pode ser desligado com `app_config.tg_monitor_analise='false'`.
- **Relatório no card**: `GET /produtos/:id` devolve `anuncio.monitor.alertas`
  (últimos 20 por MLB); a página renderiza o bloco **"Relatório de mudanças"**
  dentro do card do concorrente (`alertasHtml`), com ícone por tipo e data/hora.
- **Origem do dado**: como o snapshot é alimentado pela API pública/scraping (job
  diário) **e pela extensão** (a cada coleta), o alerta cobre as duas fontes — o
  preço mudado que a extensão captura no navegador real também vira alerta.

## Gastos de IA (v56)

Toda chamada de IA registra tokens+custo em `ai_usage_log` (`llm.js` lê `usage` da
resposta e calcula `cost_usd` = tokens×preço; preço por env `AI_PRICE_IN_PER_MTOK`/
`AI_PRICE_OUT_PER_MTOK`, padrão Haiku in $1 / out $5 por MTok). O card **"Gastos de
IA"** na lista mostra hoje/mês/total + custo médio por análise. **Saldo**: a API da
Anthropic **não expõe** o saldo da conta, então o usuário informa (`POST /ia/saldo` →
`ai_settings`) e a estimativa (`GET /ia/gastos`) calcula `restante = saldo − gasto
desde que informou`, `est_analises = restante/custo médio` e `est_dias = restante/
(gasto dos últimos 7d ÷ 7)`.

## Pendências

- **Feito (extensão turbinada):** o extrator agora tira do `pageText` `reputation`
  (MercadoLíder + nível), `shipping` (FULL/FLEX), `seller` (melhorado) e `location`
  (cidade/estado, best-effort); a rota `/extension/anuncio` mapeia tudo no card. A
  extensão é o **motor de monitoramento** — o servidor não lê concorrente (ML bloqueia
  API 403 com/sem token + entrega página sem preço ao IP do servidor); só a extensão,
  no navegador real, pega preço e campos. Cada coleta grava snapshot de preço.
- Fase 2 (inteligência de preço/mapa/simulador) e os outros 6 agentes de IA da Fase 3.
