// Proxy de impressora térmica — roda no PC da loja
// Recebe requisições HTTP do servidor em nuvem e imprime na impressora local
// Uso: node thermal-proxy.js

const http = require('http');
const Escpos = require('escpos');
require('escpos-network');

const PROXY_PORT = process.env.THERMAL_PROXY_PORT || 3001;
const PRINTER_IP = process.env.THERMAL_PRINTER_IP || '192.168.1.100';
const PRINTER_PORT = process.env.THERMAL_PRINTER_PORT || 9100;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('[thermal-proxy] recebido pedido de impressão:', data.shipping_id);

        // Conecta à impressora local
        const device = new Escpos.Network(PRINTER_IP, PRINTER_PORT);
        const printer = new Escpos.Printer(device);

        await printer
          .open()
          .then(() => {
            printer
              .initialize()
              .align('ct')
              .qrimage(data.shipping_id, { type: 'image/png', mode: 'dhdw' })
              .feed(1)
              .setTextSize(1, 1)
              .text(`LOJA: ${data.store_name || 'EMPRESA XYZ'}`.substring(0, 32))
              .feed(1);

            if (data.sku) {
              printer
                .setTextSize(1, 1)
                .text(`SKU: ${data.sku}`.substring(0, 32))
                .feed(1);
            }

            printer
              .setTextSize(0, 0)
              .feed(1)
              .text('---------------------------------------')
              .feed(1)
              .align('lt')
              .setTextSize(0, 0)
              .text(`${data.product_name}`.substring(0, 40))
              .feed(1);

            if (data.variation_type) {
              printer
                .text(`TIPO: ${data.variation_type}`.substring(0, 40))
                .feed(1);
            }

            printer
              .align('ct')
              .feed(1)
              .setTextSize(1, 1)
              .text('⚠ PRODUTO FRAGIL ⚠')
              .feed(1)
              .setTextSize(0, 0)
              .text('POR FAVOR')
              .text('CUIDADO AO MANUSEAR')
              .feed(1)
              .align('lt')
              .feed(1);

            const now = new Date();
            const dateStr = now.toLocaleDateString('pt-BR');
            const timeStr = now.toLocaleTimeString('pt-BR');
            printer
              .setTextSize(0, 0)
              .text(`${dateStr} ${timeStr}`)
              .feed(1);

            printer
              .align('ct')
              .feed(1)
              .setTextSize(0, 0)
              .text('PRODUTO EMBALADO')
              .text(`PELA ${data.company_name || 'EMPRESA XYZ'}`.substring(0, 32))
              .feed(2)
              .cut()
              .close();
          });

        console.log('[thermal-proxy] ✓ rótulo impresso:', data.shipping_id);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[thermal-proxy] erro:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', printer: `${PRINTER_IP}:${PRINTER_PORT}` }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[thermal-proxy] ✓ proxy escutando em porta ${PROXY_PORT}`);
  console.log(`[thermal-proxy] impressora: ${PRINTER_IP}:${PRINTER_PORT}`);
  console.log(`[thermal-proxy] configure no servidor: THERMAL_PROXY_URL=http://<IP_DESTA_MAQUINA>:${PROXY_PORT}`);
});
