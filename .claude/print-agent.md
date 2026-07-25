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
Enfileiramento por `store_id` cai na 1ª estação da loja; ou passe `station_id`
explícito. Assim UNIFULL e r souza podem imprimir em máquinas diferentes.

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
- Frontend ligado: `confirmAndSendPrint` em `pages/embalagem.html` tenta
  `POST /api/print/jobs` primeiro (impressão automática pelo agente); se a loja não
  tiver estação cadastrada (409), cai no **PDF no navegador** (comportamento antigo,
  fallback). O payload da etiqueta já era montado pelo próprio frontend.
- Falta operacional (não é código): cadastrar a(s) estação(ões) via
  `POST /api/print/stations`, instalar o agente no PC da expedição com o token, e
  ter a Elgin PRO FULL com papel 10×15. Ver `print-agent/README.md`.
