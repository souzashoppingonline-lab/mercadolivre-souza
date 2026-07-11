// Orquestra múltiplas EventSource, chamando discoverEvents() de cada uma no
// intervalo configurado. Genérico — hoje só registra AmazonPollingEventSource,
// mas qualquer EventSource novo (Shopee, Mercado Livre no futuro) se registra
// da mesma forma, sem mudar esta classe. Ver .claude/decisions.md.

class Scheduler {
  constructor() {
    this._entries = [];
    this._timers = [];
  }

  register(source, { intervalMs }) {
    if (!intervalMs || intervalMs <= 0) {
      throw new Error('Scheduler.register requer intervalMs > 0');
    }
    this._entries.push({ source, intervalMs });
    return this;
  }

  async startAll() {
    for (const { source, intervalMs } of this._entries) {
      await source.start();
      const label = source.constructor.name;
      const run = () => {
        source.discoverEvents().catch((err) => {
          console.error(`[scheduler] ${label}.discoverEvents falhou:`, err.message);
        });
      };
      run(); // primeira execução imediata, sem esperar o 1º intervalo
      this._timers.push(setInterval(run, intervalMs));
      console.log(`[scheduler] ${label} registrado — intervalo ${Math.round(intervalMs / 60000)}min`);
    }
  }

  async stopAll() {
    this._timers.forEach(clearInterval);
    this._timers = [];
    for (const { source } of this._entries) {
      await source.stop();
    }
  }
}

module.exports = { Scheduler };
