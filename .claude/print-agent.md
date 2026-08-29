# Print Agent — impressão automática de etiquetas (10×15 térmica)

Impressão silenciosa das etiquetas de expedição por um **agente local** rodando no
PC da expedição, sem caixa de diálogo do navegador. Padrão consagrado (mesma ideia
do PrintNode/QZ Tray): navegador não imprime sozinho em impressora USB, então um
programinha local fala direto com a impressora.

Código do agente (fora do `server/`): pasta `print-agent/` na raiz do repo
(`agent.js`, `config.example.json`, `README.md`). Node nativo, sem deps npm.

## Fluxo ponta a ponta

1. Operador bipa a etiqueta no dashboard (Embalagem).
2. Dashboard chama `POST /api/print/jobs` → cria um `print_job` `pending` roteado
   pra uma **estação** e publica WS `print:{station_id}`.
3. O agente (autenticado por **token de estação**) reivindica o job
   (`GET /print-agent/jobs/next`), baixa o PDF (`/print-agent/jobs/:id/pdf`),
   imprime via **SumatraPDF** (`-print-to "<printer>" -print-settings noscale`) e
   confirma (`POST /print-agent/jobs/:id/confirm`).

O PDF **não é guardado**: é regerado sob demanda a partir de `print_jobs.label`
(mesmo payload do `generateLabelPDF` em `server/src/thermal/pdfLabel.js`).

## Fronteira de autenticação (importante)

- Rotas do **agente** (`/print-agent/*`, `server/src/routes/printAgent.js`) são
  montadas **antes** do `requireStaffAuth` (o agente é headless, sem cookie). Auth
  por token de estação no header `X-Station-Token`.
- Rotas de **gestão** (`/api/print/*`, `server/src/routes/print.js`) ficam atrás do
  gate de staff (uso pelo dashboard): enfileirar job, cadastrar/listar estações,
  monitorar a fila.

## Multi-estação

Cada PC/impressora = uma linha em `print_stations` (com seu `token` e
`printer_name`). `print_jobs.station_id` roteia a etiqueta pra impressora certa.

Resolução da estação no enfileiramento (`resolveStationId` em `routes/print.js`),
nessa ordem: **1)** `station_id` explícito no body; **2)** estação da `store_id`;
**3)** estação **global** (`store_id IS NULL`) — uma impressora só pra todas as lojas.
**Dentro dos níveis 2 e 3, quando há mais de uma candidata, escolhe a de `last_seen`
mais recente** (`ORDER BY last_seen DESC NULLS LAST, id`) — nunca a de menor id.

> **Bug real corrigido**: com 2 estações globais cadastradas (2 PCs de
> expedição), o fallback automático ordenava só por `id`, então a estação
> cadastrada primeiro sempre vencia — mesmo com o agente dela offline há
> semanas — enquanto a estação de verdade ativa (id maior) nunca recebia job
> nenhum sem seleção manual no seletor da tela. Sintoma: job enfileirado com
> sucesso (`✓ enfileirado pro agente de impressão` no console), mas nada saía
> na impressora do PC ativo. Corrigido pra priorizar `last_seen`.

O frontend (`pages/embalagem.html`, `loadPrintStations`) deixa **cada PC escolher a
sua estação** — salvo em `localStorage['print_station_id']` e enviado como
`station_id` no enfileiramento (essa seleção explícita sempre vence a heurística
automática acima, é o jeito garantido de fixar 1 PC numa impressora específica). O
seletor só aparece quando há **2+ estações** (com 1 só, roteia sozinho por ela). É
assim que múltiplas estações de embalagem (vários PCs, várias impressoras)
funcionam: cada PC bipa e imprime na sua própria impressora, independente da loja
do pedido — mas SEM seleção manual, `last_seen` decide, então uma estação nova
recém-cadastrada só vence a automática depois do 1º poll bem-sucedido do agente
(antes disso, `last_seen IS NULL` fica sempre por último — `NULLS LAST`).

> **Bug real corrigido — o `<select>` de estação abria e fechava sem deixar
> escolher**: a página mantém o campo de bipagem sempre em foco (o leitor de
> código de barras USB "digita" no elemento focado) via um listener global de
> `click` no `document` + um handler de `blur` no `scanInput`, ambos chamando
> `refocusScan()`. Esses dois mecanismos não sabiam da existência do seletor
> `#printStationRow` — clicar nele pra abrir o dropdown nativo disparava o
> listener global, que devolvia o foco pro `scanInput` na hora, fechando o
> `<select>` antes de dar tempo de escolher uma opção. Corrigido: tanto o
> listener de clique quanto `refocusScan()` agora ignoram interações dentro de
> `#printStationRow` (via `Element.contains()`), e `sel.onchange` devolve o
> foco pro `scanInput` explicitamente **depois** que a escolha é feita — pra
> não regredir o "sempre focado" que o resto da tela depende.

## Confiabilidade

- **Claim atômico**: `GET /print-agent/jobs/next` faz `UPDATE ... FOR UPDATE SKIP
  LOCKED` — duas instâncias do agente nunca pegam o mesmo job.
- **Recuperação**: job preso em `printing` há >2min volta a ser reivindicável.
- **Retry**: `POST /print-agent/jobs/:id/error` reagenda (`pending`) até 3
  tentativas; depois marca `error`.
- **Offline**: VPS/agente fora do ar → jobs ficam `pending` e imprimem ao voltar.

## Escala da etiqueta

`-print-settings noscale` é obrigatório — sem isso o Windows encolhe a 10×15
("fit to page"). A impressora (ex.: Elgin PRO FULL) precisa estar com papel 10×15
como padrão.

## Estado

- Backend (migration v49 + rotas `/api/print/*` e `/print-agent/*` + WS) implementado.
- Frontend ligado e **automático**: o **2º bipe** (que encerra a gravação) dispara
  `printThermalLabel` → `confirmAndSendPrint` **direto, sem modal de confirmação** —
  bipou 2x, sai a etiqueta. A etiqueta leva só os campos já existentes (produto, SKU,
  loja, variação, QR do `shipping_id`), nenhum a mais. `confirmAndSendPrint` tenta
  `POST /api/print/jobs` (agente); se a loja não tem estação (409), cai no **PDF no
  navegador** (fallback). O modal de confirmação antigo foi removido.
- Falta operacional (não é código): cadastrar a(s) estação(ões) via
  `POST /api/print/stations`, instalar o agente no PC da expedição com o token, e
  ter a Elgin PRO FULL com papel 10×15. Ver `print-agent/README.md`.
