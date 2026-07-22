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
  doc.image(qrImage, (width - 60) / 2, 8, { width: 60, height: 60 });

  // Loja (bold, grande)
  doc.fontSize(14).font('Helvetica-Bold');
  doc.text(`LOJA: ${store_name || '(sem loja)'}`.substring(0, 32), 8, 73, {
    width: width - 16,
    align: 'center',
  });

  // SKU
  if (sku) {
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text(`SKU: ${sku}`.substring(0, 32), 8, 93, {
      width: width - 16,
      align: 'center',
    });
  }

  // Separador
  doc.moveTo(8, 110).lineTo(width - 8, 110).stroke();

  // Produto (normal, pequeno)
  doc.fontSize(11).font('Helvetica');
  doc.text(`Produto:`, 8, 117);
  doc.fontSize(12).font('Helvetica-Bold');
  doc.text(`${product_name}`.substring(0, 40), 8, 132, {
    width: width - 16,
  });

  // Variação
  if (variation_type) {
    doc.fontSize(11).font('Helvetica');
    doc.text(`Tipo:`, 8, 157);
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text(`${variation_type}`.substring(0, 40), 8, 172, {
      width: width - 16,
    });
  }

  // Aviso frágil
  doc.fontSize(12).font('Helvetica-Bold').fillColor('red');
  doc.text('⚠ PRODUTO FRÁGIL ⚠', 8, 197, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(10).font('Helvetica').fillColor('black');
  doc.text('POR FAVOR CUIDADO AO MANUSEAR', 8, 213, {
    width: width - 16,
    align: 'center',
  });

  // Data/hora
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR');
  doc.fontSize(10).font('Helvetica');
  doc.text(`${dateStr} ${timeStr}`, 8, 233, {
    width: width - 16,
    align: 'center',
  });

  // Footer
  doc.fontSize(11).font('Helvetica-Bold');
  doc.text('PRODUTO EMBALADO', 8, 256, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(10).font('Helvetica');
  doc.text('COM TODOS OS PADRÕES', 8, 270, {
    width: width - 16,
    align: 'center',
  });
  doc.fontSize(10).font('Helvetica');
  doc.text('DE QUALIDADE E SEGURANÇA', 8, 282, {
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
