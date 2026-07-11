// Contrato comum para descoberta de eventos de um marketplace, independente
// do mecanismo (polling, webhook, Notifications API/SNS-SQS). Os Workers que
// consomem os eventos publicados nunca sabem qual EventSource os originou —
// só reagem ao formato padronizado { marketplace, event, resourceId, sellerId, timestamp }
// publicado numa fila BullMQ. Ver .claude/decisions.md ("Marketplace Engine — EventSource").
//
// Implementação real hoje: server/src/marketplaces/amazon/AmazonPollingEventSource.js.
// MercadoLivreEventSource/ShopeeEventSource não existem ainda — o ML continua
// no fluxo de webhook atual (Gateway → BullMQ → worker.js), intocado.

class EventSource {
  /** Prepara o que for necessário antes do primeiro discoverEvents (ex: resolver marketplace_id). */
  async start() {
    throw new Error(`${this.constructor.name}.start não implementado`);
  }

  /** Libera recursos/conexões ao encerrar. */
  async stop() {
    throw new Error(`${this.constructor.name}.stop não implementado`);
  }

  /** Busca eventos novos/alterados desde a última execução e os publica na fila padronizada. */
  async discoverEvents() {
    throw new Error(`${this.constructor.name}.discoverEvents não implementado`);
  }
}

module.exports = { EventSource };
