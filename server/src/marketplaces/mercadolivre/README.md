Pasta reservada, intencionalmente vazia por enquanto.

O Mercado Livre continua implementado em `server/src/mlClient.js` +
`server/src/routes/auth.js` (fora da camada `marketplaces/`) porque é a
única integração em produção — não deve ser tocada/migrada sem uma tarefa
dedicada, depois que o padrão `MarketplaceClient` provar valor com a Amazon.
Ver `.claude/decisions.md` e `.claude/mercadolivre.md`.
