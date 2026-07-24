# FinanceEcom Monitor — Chrome Extension

Extensão Chrome para monitoramento e coleta de dados de anúncios no Mercado Livre.

## Funcionalidades

- Extração de dados de produtos: títulos, preços, quantidade de vendas
- Coleta de comentários, perguntas e avaliações
- Configuração customizável de URL da API
- Interface de popup simples e intuitiva

## Instalação

### Desenvolvimento (Mode Developer)

1. Abra `chrome://extensions/` no seu navegador
2. Ative **"Modo de desenvolvedor"** (canto superior direito)
3. Clique **"Carregar extensão não empacotada"**
4. Selecione a pasta `chrome-extension/`
5. Pronto! A extensão está instalada

### Configuração

1. Clique no ícone da extensão (📊 FinanceEcom)
2. No popup, configure a **URL da API** (padrão: `http://localhost:3000/api`)
3. A URL é salva automaticamente no `chrome.storage.local`

## Uso

1. Abra uma página de produto no Mercado Livre
2. Clique no ícone da extensão
3. Clique no botão **"📥 Coletar Dados"**
4. Aguarde o carregamento — os dados extraídos aparecerão na seção **"Dados Coletados"**
5. Os dados são enviados automaticamente para a API configurada

## Estrutura

- `manifest.json` — Configuração da extensão (v3)
- `popup.html` — Interface do popup
- `popup.js` — Lógica de UI e envio de dados
- `content.js` — Script injetado nas páginas ML (extração de DOM)
- `background.js` — Service worker (eventos de background)

## Como funciona

1. **Content Script** (`content.js`) extrai dados do DOM da página:
   - Título do produto (h1)
   - Preço (seletores dinâmicos)
   - Vendas (regex no texto)
   - Comentários e perguntas (seletores por classe)
   - Avaliação média

2. **Popup** (`popup.js`) recebe os dados via `chrome.scripting.executeScript()`

3. **Backend** (`server/src/routes/api.js`) recebe POST `/marketplace-events/collect` e processa

## Variáveis de Ambiente

Nenhuma env específica — a URL da API é configurada no popup.

## Limites

- Só funciona em páginas do Mercado Livre
- Chrome/Chromium apenas (não compatível com Firefox sem adaptação)
- Extração de dados é baseada em seletores DOM — mudanças no HTML do ML podem quebrar

## Próximos passos

- Armazenar dados coletados em tabela `extension_collections` no banco
- Dashboard de histórico de coletas
- Export CSV dos dados
- Integração com alertas Telegram
