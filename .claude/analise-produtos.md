# Análise de Produtos

Módulo de **decisão de compra**: cadastra um produto (com custos reais), coleta
anúncios concorrentes do Mercado Livre via **extensão Chrome**, e (fases futuras)
cruza tudo com IA pra dizer se vale vender, preço ideal, margem e volume.

Construído em **fases** (evita virar um monstro):
- **Fase 1 (feita):** cadastro de produto + custos, fila de "produto ativo para
  coleta", página com tabela + modal + tela do produto com cards ao vivo (WS).
- **Fase 2 (futuro):** inteligência de preço/concorrência + mapa geográfico +
  simulador preço×lucro (usa as fórmulas de `finance.md`), tudo cálculo, sem IA.
- **Fase 3 (futuro):** 9 agentes de IA (mercado, financeiro, comercial, marketing,
  comentários, perguntas, criativos, SEO, decisão) + Score do Produto. Precisa de
  chave de LLM.

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
- `POST /produtos/:id/analisar` → stub (Fase 3).
- `POST /produtos/:id/anuncio` → **adiciona concorrente à mão** (publica WS `analise_anuncio`).
- `POST /anuncios/:adId/editar` → completa/corrige campos que a extensão não pegou (ex.: comentários, nota). `fotos` só sobrescreve se vier nova.
- `POST /anuncios/:adId/excluir` → remove um card.

O anúncio tem `observacoes` (v51) pra anotar à mão o que a extensão não capturou. `is_full`/`is_flex` no banco viram `full`/`flex` na API via `mapAd`.

**Comentários — dois campos separados:**
- `comentarios_auto` (v53) — os comentários VISÍVEIS que o extrator (`extractCommentsText`) recorta da seção "Opiniões" do `pageText`. **A extensão preenche sozinha** e atualiza a cada recoleta.
- `comentarios_texto` (v52) — só do operador: os comentários antigos (que o ML esconde atrás de "Mostrar todas as opiniões"), colados à mão. **A extensão nunca toca** neste campo.

São colunas distintas de propósito, pra a coleta automática não sobrescrever o que o operador colou. Ambos são texto cru (a IA da Fase 3 lê e agrupa reclamações/elogios) e distintos de `comentarios`, que é só a contagem numérica.

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

## Extensão Chrome (`chrome-extension/`)

`content.js` injeta um botão "Coletar p/ análise" na página do ML, coleta
`pageText` + `jsonLd` (não o innerHTML — grande demais) e manda pro
`service-worker.js`, que faz `POST /extension/anuncio` (padrão apiUrl
`https://multimixvendas.duckdns.org`, configurável no popup). O `popup.js` mostra
o **produto ativo** (`GET /extension/produto-ativo`) — a extensão nunca pergunta o
alvo. `manifest.json` tem host_permission pro servidor. A rota antiga
`/extension/collect` (`extensionCollect.js`) virou legado.

Limite do body: `express.json({ limit: '1mb' })` (o pageText cabe; o innerHTML não
é mais enviado).

## Pendências

- Enriquecer o extrator: `reputacao`, `full`/`flex`, `cidade`/`estado` ainda não
  vêm do `pageText` — o operador completa à mão (editar card). Fase futura.
- Fases 2 e 3 (inteligência de preço/mapa/simulador + os 9 agentes de IA).
