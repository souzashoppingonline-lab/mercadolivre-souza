// Shared WebSocket hub. The HTTP server attaches clients here; the worker
// process publishes events via Redis pub/sub so both processes stay in sync
// even when running on separate machines/containers.
const WebSocket = require('ws');
const redis = require('../db/redis');

const CHANNEL = 'ml:ws:broadcast';
const clients = new Set();
const subscriber = redis.duplicate();

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  // Ping nativo WS a cada 30s para manter conexão viva no nginx/proxy
  const pingTimer = setInterval(() => {
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      } else {
        clients.delete(socket);
      }
    }
  }, 30000);

  wss.on('close', () => clearInterval(pingTimer));

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') socket.send(JSON.stringify({ topic: 'pong', payload: {} }));
      } catch {}
    });
  });

  subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_channel, message) => {
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  });

  return wss;
}

// Called by workers (possibly a different process) to push an update.
async function publish(topic, payload) {
  await redis.publish(CHANNEL, JSON.stringify({ topic, payload }));
}

module.exports = { attach, publish };
