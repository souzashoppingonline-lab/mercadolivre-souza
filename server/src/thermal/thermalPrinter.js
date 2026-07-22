// Integração de impressora térmica (rede) — gera rótulo de embalagem com QR code
// Usa ESC/POS via biblioteca escpos + escpos-network
const Escpos = require('escpos');
require('escpos-network');
const env = require('../config/env');

// Gera e envia rótulo de embalagem (10x15 cm) pra impressora térmica
// data: { shipping_id, product_name, variation_type, sku, company_name }
async function printLabel(data) {
  const {
    shipping_id,
    product_name,
    variation_type,
    sku,
    company_name = 'EMPRESA XYZ',
  } = data;

  // Se impressora não está configurada, return silenciosamente (não é erro)
  if (!env.thermalPrinter.ip) {
    console.warn('[thermal] impressora não configurada (THERMAL_PRINTER_IP vazio) — pulando impressão');
    return { ok: false, reason: 'printer_not_configured' };
  }

  try {
    // Conecta via rede (socket raw, porta padrão 9100)
    const device = new Escpos.Network(env.thermalPrinter.ip, env.thermalPrinter.port);
    const printer = new Escpos.Printer(device);

    // Gera o rótulo
    await printer
      .open()
      .then(() => {
        printer
          // Inicializa impressora
          .initialize()
          // Centraliza tudo
          .align('ct')
          // QR code com shipping_id (máximo ~2953 bytes de dados)
          .qrimage(shipping_id, { type: 'image/png', mode: 'dhdw' })
          // Espaço
          .feed(1)
          // Dados do produto (alinha esquerda para nome/tipo/sku)
          .align('lt')
          .setTextSize(1, 1)
          .text(`${product_name}`.substring(0, 32))
          .feed(1);

        // Tipo/variação se houver
        if (variation_type) {
          printer
            .setTextSize(0, 0)
            .text(`TIPO: ${variation_type}`.substring(0, 40))
            .feed(1);
        }

        // SKU
        if (sku) {
          printer
            .text(`SKU: ${sku}`.substring(0, 40))
            .feed(1);
        }

        // Linha de separação
        printer
          .feed(1)
          .text('---------------------------------------')
          .feed(1);

        // Timestamp
        const now = new Date();
        const dateStr = now.toLocaleDateString('pt-BR');
        const timeStr = now.toLocaleTimeString('pt-BR');
        printer
          .setTextSize(0, 0)
          .text(`${dateStr} ${timeStr}`)
          .feed(1);

        // Texto de embalagem (destacado)
        printer
          .setTextSize(1, 1)
          .align('ct')
          .text('PRODUTO EMBALADO')
          .text(`PELA ${company_name}`.substring(0, 32))
          .feed(2);

        // Corta o papel
        printer
          .cut()
          .close();
      });

    console.log('[thermal] rótulo impresso com sucesso:', shipping_id);
    return { ok: true };
  } catch (e) {
    console.error('[thermal] erro ao imprimir rótulo:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { printLabel };
