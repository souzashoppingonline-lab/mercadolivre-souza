// Gera PDF de etiqueta 10x15 cm para impressão
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Readable } = require('stream');

async function generateLabelPDF(data) {
  const {
    shipping_id,
    product_name,
    variation_type,
    sku,
    store_name,
    company_name = 'EMPRESA XYZ',
  } = data;

  // 10x15 cm = 283.46 x 425.19 pontos (72 DPI)
  const width = 283.46;
  const height = 425.19;

  const doc = new PDFDocument({
    size: [width, height],
    margin: 8,
  });

  // Gera QR code como data URL
  const qrDataUrl = await QRCode.toDataURL(shipping_id, {
    errorCorrectionLevel: 'H',
    type: 'image/png',
    width: 80,
  });

  const buffers = [];
  doc.on('data', (buf) => buffers.push(buf));

  // QR code no topo (centralizado)
  const qrImage = Buffer.from(qrDataUrl.split(',')[1], 'base64');
  doc.image(qrImage, (width - 80) / 2, 8, { width: 80, height: 80 });

  // Loja (bold, grande)
  doc.fontSize(12).font('Helvetica-Bold');
  doc.text(`LOJA: ${store_name || '(sem loja)'}`.substring(0, 32), 8, 95, {
    width: width - 16,
    align: 'center',
  });

  // SKU
  if (sku) {
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text(`SKU: ${sku}`.substring(0, 32), 8, 112, {
      width: width - 16,
      align: 'center',
    });
  }

  // Separador
  doc.moveTo(8, 130).lineTo(width - 8, 130).stroke();

  // Produto (normal, pequeno)
  doc.fontSize(9).font('Helvetica');
  doc.text(`Produto:`, 8, 135);
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text(`${product_name}`.substring(0, 40), 8, 147, {
    width: width - 16,
  });

  // Variação
  if (variation_type) {
    doc.fontSize(9).font('Helvetica');
    doc.text(`Tipo:`, 8, 167);
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(`${variation_type}`.substring(0, 40), 8, 179, {
      width: width - 16,
    });
  }

  // Aviso frágil
  doc.fontSize(10).font('Helvetica-Bold').fillColor('red');
  doc.text('⚠ PRODUTO FRÁGIL ⚠', 8, 195, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(8).font('Helvetica').fillColor('black');
  doc.text('POR FAVOR CUIDADO AO MANUSEAR', 8, 209, {
    width: width - 16,
    align: 'center',
  });

  // Data/hora
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR');
  doc.fontSize(8).font('Helvetica');
  doc.text(`${dateStr} ${timeStr}`, 8, 228, {
    width: width - 16,
    align: 'center',
  });

  // Footer
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('PRODUTO EMBALADO', 8, 245, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(8).font('Helvetica');
  doc.text('COM TODOS OS PADRÕES', 8, 256, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(8).font('Helvetica');
  doc.text('DE QUALIDADE E SEGURANÇA', 8, 266, {
    width: width - 16,
    align: 'center',
  });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
    doc.on('error', reject);
  });
}

module.exports = { generateLabelPDF };
