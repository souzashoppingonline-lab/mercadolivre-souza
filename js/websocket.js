// WebSocket client — receives real-time updates pushed by the backend after
// BullMQ workers update PostgreSQL + Redis. Pages subscribe to topics they care about.
const WS = {
  socket: null,
  listeners: {},
  reconnectDelay: 2000,
  _url: localStorage.getItem('ml_ws_url') || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',

  connect() {
    if (this.socket && this.socket.readyState < 2) return;
    this.socket = new WebSocket(this._url);

    this.socket.onopen = () => {
      console.log('[WS] connected');
      this.reconnectDelay = 2000;
      this._dispatch('_connected', {});
    };

    this.socket.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        this._dispatch(msg.topic, msg.payload);
      } catch {}
    };

    this.socket.onclose = () => {
      console.warn('[WS] disconnected — reconnecting in', this.reconnectDelay, 'ms');
      this._dispatch('_disconnected', {});
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    this.socket.onerror = (e) => console.error('[WS] error', e);
  },

  on(topic, fn) {
    (this.listeners[topic] = this.listeners[topic] || []).push(fn);
    return () => this.off(topic, fn);
  },

  off(topic, fn) {
    this.listeners[topic] = (this.listeners[topic] || []).filter(f => f !== fn);
  },

  _dispatch(topic, payload) {
    (this.listeners[topic] || []).forEach(fn => fn(payload));
    (this.listeners['*'] || []).forEach(fn => fn({ topic, payload }));
  }
};

// Topics emitted by the backend after each worker run:
// 'kpis_updated'         → dashboard KPIs changed
// 'order_updated'        → a pedido changed status
// 'question_received'    → new ML question
// 'message_received'     → new ML message
// 'stock_alert'          → low stock threshold hit
// 'anuncio_updated'      → listing changed
// 'webhook_received'     → raw webhook log entry

WS.connect();
