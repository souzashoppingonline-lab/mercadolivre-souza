// Proxy de impressora térmica — roda no PC da loja
// Suporta: impressora via rede (IP:porta) ou USB (ELGIN)
// Uso: THERMAL_PRINTER_IP=USB node thermal-proxy.js
//      THERMAL_PRINTER_IP=192.168.1.100 THERMAL_PRINTER_PORT=9100 node thermal-proxy.js

const http = require('http');
const Escpos = require('escpos');
require('escpos-network');

const PROXY_PORT = process.env.THERMAL_PROXY_PORT || 3001;
const PRINTER_IP = process.env.THERMAL_PRINTER_IP || '127.0.0.1';
const PRINTER_PORT = process.env.THERMAL_PRINTER_PORT || '9100';
const IS_USB = PRINTER_IP.toUpperCase() === 'USB' || PRINTER_IP.toUpperCase() === 'ELGIN';

async function printViaNetwork(data) {
  return new Promise((resolve, reject) => {
    const device = new Escpos.Network(PRINTER_IP, PRINTER_PORT);
    const printer = new Escpos.Printer(device);

    printer
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

        resolve();
      })
      .catch(reject);
  });
}

async function printViaUSB(data) {
  // Para ELGIN L42PRO USB, usa SerialPort
  let SerialPort;
  try {
    SerialPort = require('serialport').SerialPort;
  } catch (e) {
    throw new Error('serialport não instalado. Execute: npm install serialport');
  }

  // Lista portas disponíveis
  const ports = await SerialPort.list();
  console.log('[thermal-proxy] portas disponíveis:', ports.map(p => `${p.path} (${p.manufacturer})`).join(', '));

  // Tenta encontrar a ELGIN
  let elginPort = ports.find(p =>
    (p.manufacturer && p.manufacturer.includes('ELGIN')) ||
    (p.vendorId === '0416') ||
    p.path.includes('USB')
  );

  if (!elginPort) {
    // Se não achar, usa a primeira porta USB como fallback
    elginPort = ports.find(p => p.path.includes('COM') || p.path.includes('USB'));
  }

  if (!elginPort) {
    throw new Error(`Impressora ELGIN não encontrada. Portas disponíveis: ${ports.map(p => p.path).join(', ')}`);
  }

  console.log('[thermal-proxy] conectando em:', elginPort.path);

  const port = new SerialPort({
    path: elginPort.path,
    baudRate: 19200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none'
  });

  return new Promise((resolve, reject) => {
    port.on('error', reject);

    port.open((err) => {
      if (err) return reject(err);

      // Gera comandos ESC/POS como bytes
      const commands = [];

      // ESC @ = Initialize
      commands.push(Buffer.from([0x1B, 0x40]));

      // ESC a 1 = Align center
      commands.push(Buffer.from([0x1B, 0x61, 0x01]));

      // ESC ! 0x21 = Text size 2x2
      commands.push(Buffer.from([0x1B, 0x21, 0x21]));

      // Print QR code (using text-based QR for serial)
      commands.push(Buffer.from(`QR: ${data.shipping_id}\n`, 'utf8'));

      // ESC ! 0x00 = Normal text
      commands.push(Buffer.from([0x1B, 0x21, 0x00]));

      // Store name
      const storeName = `LOJA: ${data.store_name || 'EMPRESA XYZ'}`.substring(0, 32);
      commands.push(Buffer.from(storeName + '\n', 'utf8'));

      // SKU
      if (data.sku) {
        const sku = `SKU: ${data.sku}`.substring(0, 32);
        commands.push(Buffer.from(sku + '\n', 'utf8'));
      }

      // Separator
      commands.push(Buffer.from('---------------------------------------\n', 'utf8'));

      // Product
      commands.push(Buffer.from(`${data.product_name}\n`, 'utf8'));

      // Variation
      if (data.variation_type) {
        commands.push(Buffer.from(`TIPO: ${data.variation_type}\n`, 'utf8'));
      }

      // Warning
      commands.push(Buffer.from('⚠ PRODUTO FRAGIL ⚠\nPOR FAVOR\nCUIDADO AO MANUSEAR\n', 'utf8'));

      // Date/time
      const now = new Date();
      const dateStr = now.toLocaleDateString('pt-BR');
      const timeStr = now.toLocaleTimeString('pt-BR');
      commands.push(Buffer.from(`${dateStr} ${timeStr}\n`, 'utf8'));

      // Footer
      commands.push(Buffer.from('PRODUTO EMBALADO\n', 'utf8'));
      commands.push(Buffer.from(`PELA ${(data.company_name || 'EMPRESA XYZ').substring(0, 32)}\n\n`, 'utf8'));

      // Cut paper
      commands.push(Buffer.from([0x1D, 0x56, 0x42]));

      const fullData = Buffer.concat(commands);

      port.write(fullData, (writeErr) => {
        port.close((closeErr) => {
          if (writeErr || closeErr) reject(writeErr || closeErr);
          else resolve();
        });
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('[thermal-proxy] ✓ recebido pedido de impressão:', data.shipping_id);

        if (IS_USB) {
          console.log('[thermal-proxy] usando conexão USB/Serial...');
          await printViaUSB(data);
        } else {
          console.log(`[thermal-proxy] usando conexão de rede ${PRINTER_IP}:${PRINTER_PORT}...`);
          await printViaNetwork(data);
        }

        console.log('[thermal-proxy] ✓ rótulo impresso com sucesso:', data.shipping_id);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[thermal-proxy] ✗ erro ao imprimir:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      mode: IS_USB ? 'USB' : 'Network',
      printer: IS_USB ? 'ELGIN L42PRO' : `${PRINTER_IP}:${PRINTER_PORT}`
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`\n[thermal-proxy] ✓ proxy iniciado na porta ${PROXY_PORT}`);
  console.log(`[thermal-proxy] modo: ${IS_USB ? 'USB (ELGIN)' : `Rede (${PRINTER_IP}:${PRINTER_PORT})`}`);
  console.log(`[thermal-proxy]\n Configure no servidor em nuvem:`);
  console.log(`  THERMAL_PROXY_URL=http://<IP_DESTA_MAQUINA>:${PROXY_PORT}\n`);
});

process.on('SIGINT', () => {
  console.log('\n[thermal-proxy] encerrando...');
  server.close();
});
