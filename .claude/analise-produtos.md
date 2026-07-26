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
  palavra reservada no Postgres); a API devolve como `full`/`flex`. `raw` guarda o
  payload cru completo da extensão.
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

**Extensão (público, a implementar no próximo passo, em `/extension`):**
- `GET /extension/produto-ativo` → `{id, produto, status}` do ativo.
- `POST /extension/anuncio` → grava o anúncio no produto ativo + publica WS.

## WebSocket

Tópico `analise_anuncio` (payload `{produto_id, anuncio}`) — publicado quando a
extensão salva um anúncio; a página insere o card sem recarregar. Mesmo padrão do
`print:{station_id}`.

## Frontend

`pages/analise-produtos.html` (menu Análises). Duas telas: lista (tabela + "Novo
Produto") e detalhe (header + cards de concorrentes ao vivo + Ativar/Finalizar
coleta + Analisar). Métodos em `js/db.js` (`getProdutosAnalise`, `criarProdutoAnalise`,
`ativarColetaProduto`, etc.).

## Pendências

- **Extensão persistindo** (o gargalo): hoje `routes/extensionCollect.js` só faz
  `console.log`. Próximo passo: `GET /extension/produto-ativo`, `POST
  /extension/anuncio` (grava + publica `analise_anuncio`), e a extensão consultando
  o produto ativo e mostrando o alvo.
- Fases 2 e 3 (inteligência + IA).
