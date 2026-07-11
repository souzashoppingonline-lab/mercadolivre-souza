// Contrato que todo adapter de marketplace deve implementar.
// Não é chamado diretamente em produção ainda — nenhuma rota/worker está
// conectada a esta camada até a decisão de schema (coluna `marketplace`
// discriminadora vs. tabelas paralelas) ser confirmada. Ver .claude/roadmap.md.
//
// mlClient.js (Mercado Livre) continua fora deste contrato por enquanto —
// é a única integração em produção e não deve ser tocada nesta tarefa.

class MarketplaceClient {
  /** Identificador curto usado como valor da coluna `marketplace` (ex: 'amazon', 'shopee'). */
  static get id() {
    throw new Error('MarketplaceClient.id não implementado');
  }

  /** Troca/renova o token de acesso para uma loja/conta. Deve lançar MarketplaceTokenInvalidError
   *  se o refresh token estiver definitivamente inválido, ou MarketplaceRateLimitError em 429. */
  async refreshAccessToken(/* storeId */) {
    throw new Error(`${this.constructor.name}.refreshAccessToken não implementado`);
  }

  /** Busca um pedido específico pelo ID do marketplace. */
  async getOrder(/* orderId, storeId */) {
    throw new Error(`${this.constructor.name}.getOrder não implementado`);
  }

  /** Lista pedidos criados/atualizados desde uma data — usado em reconciliação (equivalente ao syncVendas do ML). */
  async listRecentOrders(/* storeId, sinceISODate */) {
    throw new Error(`${this.constructor.name}.listRecentOrders não implementado`);
  }
}

module.exports = { MarketplaceClient };
