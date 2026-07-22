// Integração de impressora térmica — rótulo de embalagem com QR code
// Dois modos:
// 1. Com THERMAL_PROXY_URL: envia requisição HTTP ao proxy local
// 2. Sem proxy: conecta diretamente via rede ESC/POS (Escpos.Network)

const Escpos = require('escpos');
require('escpos-network');
const env = require('../config/env');

// Gera e envia rótulo de embalagem (10x15 cm) pra impressora térmica
// data: { shipping_id, product_name, variation_type, sku, store_name, company_name }
async function printLabel(data) {
  console.log('[thermal/printLabel] iniciado com dados:', data);

  const {
    shipping_id,
    product_name,
    variation_type,
    sku,
    store_name,
    company_name = 'EMPRESA XYZ',
  } = data;

  console.log('[thermal/printLabel] env.thermalPrinter:', env.thermalPrinter);
  console.log('[thermal/printLabel] env.thermalProxyUrl:', env.thermalProxyUrl);

  // Modo 1: Se há proxy local (servidor em nuvem chamando PC da loja)
  if (env.thermalProxyUrl) {
    console.log('[thermal] usando proxy local:', env.thermalProxyUrl);
    return printViaProxy(data, env.thermalProxyUrl);
  }

  // Modo 2: Conexão direta via rede ESC/POS
  if (!env.thermalPrinter.ip || env.thermalPrinter.ip === 'USB') {
    console.warn('[thermal] impressora não configurada (THERMAL_PRINTER_IP vazio ou USB) — pulando impressão');
    return { ok: false, reason: 'printer_not_configured' };
  }

  try {
    console.log('[thermal] conectando à impressora diretamente:', env.thermalPrinter.ip, ':', env.thermalPrinter.port);
    return await printViaNetwork(data);
  } catch (e) {
    console.error('[thermal] ✗ erro ao imprimir rótulo:', e.message, e.stack);
    return { ok: false, error: e.message };
  }
}

async function printViaProxy(data, proxyUrl) {
  try {
    console.log('[thermal] enviando para proxy:', proxyUrl);
    const response = await fetch(proxyUrl + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const result = await response.json();
    console.log('[thermal] ✓ resposta do proxy:', result);
    return result;
  } catch (e) {
    console.error('[thermal] ✗ erro ao chamar proxy:', e.message);
    return { ok: false, error: e.message };
  }
}

async function printViaNetwork(data) {
  return new Promise((resolve, reject) => {
    const {
      shipping_id,
      product_name,
      variation_type,
      sku,
      store_name,
      company_name = 'EMPRESA XYZ',
    } = data;

    try {
      console.log('[thermal] abrindo conexão com impressora...');
      const device = new Escpos.Network(env.thermalPrinter.ip, env.thermalPrinter.port);
      const printer = new Escpos.Printer(device);

      printer
        .open()
        .then(() => {
          console.log('[thermal] ✓ conexão aberta, enviando comandos ESC/POS...');
          printer
            .initialize()
            .align('ct')
            .qrimage(shipping_id, { type: 'image/png', mode: 'dhdw' })
            .feed(1)
            .setTextSize(1, 1)
            .text(`LOJA: ${store_name || company_name}`.substring(0, 32))
            .feed(1);

          if (sku) {
            printer
              .setTextSize(1, 1)
              .text(`SKU: ${sku}`.substring(0, 32))
              .feed(1);
          }

          printer
            .setTextSize(0, 0)
            .feed(1)
            .text('---------------------------------------')
            .feed(1)
            .align('lt')
            .setTextSize(0, 0)
            .text(`${product_name}`.substring(0, 40))
            .feed(1);

          if (variation_type) {
            printer
              .text(`TIPO: ${variation_type}`.substring(0, 40))
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
            .text(`PELA ${company_name}`.substring(0, 32))
            .feed(2);

          printer
            .cut()
            .close();

          console.log('[thermal] ✓ comandos ESC/POS finalizados (cut + close)');
          resolve({ ok: true });
        })
        .catch(reject);
    } catch (e) {
      console.error('[thermal] ✗ erro ao criar device/printer:', e.message);
      reject(e);
    }
  });
}

module.exports = { printLabel };
