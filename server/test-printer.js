// Servidor fake que simula uma impressora térmica ESC/POS
// Escuta na porta 9100 (padrão ESC/POS) e loga todos os comandos recebidos

const net = require('net');

const server = net.createServer((socket) => {
  console.log('[fake-printer] cliente conectado:', socket.remoteAddress);

  socket.on('data', (data) => {
    // ESC/POS começa com ESC (0x1B)
    if (data[0] === 0x1B) {
      console.log('[fake-printer] ✓ recebido comando ESC/POS de', data.length, 'bytes');
      console.log('[fake-printer] comando:', data.toString('hex').substring(0, 100), '...');
    } else {
      console.log('[fake-printer] recebido:', data.toString());
    }
  });

  socket.on('end', () => {
    console.log('[fake-printer] cliente desconectado');
  });

  socket.on('error', (err) => {
    console.error('[fake-printer] erro:', err.message);
  });
});

server.listen(9100, '127.0.0.1', () => {
  console.log('[fake-printer] ✓ servidor escutando em 127.0.0.1:9100');
  console.log('[fake-printer] Configure no .env: THERMAL_PRINTER_IP=127.0.0.1');
});
