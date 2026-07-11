// Taxonomia de erro compartilhada entre adapters novos (amazon/, shopee/).
// mlClient.js/worker.js (Mercado Livre) usam checagem por string em err.message
// (ex: err.message.includes('429')) — isso NÃO é alterado nesta tarefa.
// Adapters novos devem lançar estas classes para que o worker (quando a
// integração for ligada) possa despachar por `instanceof` em vez de string.

class MarketplaceRateLimitError extends Error {
  constructor(message, { retryAfterMs } = {}) {
    super(message);
    this.name = 'MarketplaceRateLimitError';
    this.retryAfterMs = retryAfterMs || null;
  }
}

class MarketplaceTokenInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketplaceTokenInvalidError';
    this.permanent = true;
  }
}

class MarketplaceTransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketplaceTransientError';
    this.transient = true;
  }
}

module.exports = { MarketplaceRateLimitError, MarketplaceTokenInvalidError, MarketplaceTransientError };
