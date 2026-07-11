// Stub — app Shopee ainda em aprovação, sem client_id/client_secret disponíveis.
// Existe só para documentar o contrato (MarketplaceClient) e permitir que o
// código de orquestração futuro já referencie 'shopee' sem quebrar.
// Ver .claude/shopee.md para status e pré-requisitos antes de implementar de verdade.
const { MarketplaceClient } = require('../interfaces/MarketplaceClient');

class ShopeeClient extends MarketplaceClient {
  static get id() { return 'shopee'; }

  async refreshAccessToken() {
    throw new Error('Shopee não implementada — app em aprovação, sem credenciais. Ver .claude/shopee.md');
  }

  async getOrder() {
    throw new Error('Shopee não implementada — app em aprovação, sem credenciais. Ver .claude/shopee.md');
  }

  async listRecentOrders() {
    throw new Error('Shopee não implementada — app em aprovação, sem credenciais. Ver .claude/shopee.md');
  }
}

module.exports = { ShopeeClient };
