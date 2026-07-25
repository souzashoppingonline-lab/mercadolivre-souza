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
  doc.fontSize(16).font('Helvetica-Bold');
  doc.text(`LOJA: ${store_name || '(sem loja)'}`.substring(0, 32), 8, 70, {
    width: width - 16,
    align: 'center',
  });

  // SKU
  if (sku) {
    doc.fontSize(16).font('Helvetica-Bold');
    doc.text(`SKU: ${sku}`.substring(0, 32), 8, 89, {
      width: width - 16,
      align: 'center',
    });
  }

  // Separador
  doc.moveTo(8, 107).lineTo(width - 8, 107).stroke();

  // Produto (normal, pequeno)
  doc.fontSize(12).font('Helvetica');
  doc.text(`Produto:`, 8, 114);
  doc.fontSize(14).font('Helvetica-Bold');
  doc.text(`${product_name}`.substring(0, 40), 8, 129, {
    width: width - 16,
  });

  // Variação
  if (variation_type) {
    doc.fontSize(12).font('Helvetica');
    doc.text(`Tipo:`, 8, 154);
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text(`${variation_type}`.substring(0, 40), 8, 169, {
      width: width - 16,
    });
  }

  // ── Aviso FRÁGIL — elemento DOMINANTE da etiqueta ─────────────────────────
  // Duas linhas centralizadas: "PRODUTO" (menor, negrito) + "FRÁGIL" (o maior
  // texto da etiqueta). O tamanho de "FRÁGIL" é calculado pra preencher a largura
  // útil sem cortar/quebrar (widthOfString escala linear com a fonte), limitado
  // pela altura reservada ao aviso. Sem símbolos. Vetorial → imprime nítido a
  // qualquer DPI (203 incl.). O bloco é centralizado vertical e horizontalmente.
  const usableW = width - 16;          // largura útil (267.46 pt)
  const warnTop = 195;                 // logo abaixo do bloco de produto/variação
  const warnBottom = 345;              // deixa espaço pra data + rodapé
  const warnH = warnBottom - warnTop;  // ~150 pt (~37% da altura útil)

  // Maior fonte (pt) em que `text` cabe em `maxW` de largura, na fonte dada.
  const maxFontForWidth = (text, font, maxW) => {
    doc.font(font).fontSize(100);
    return (maxW / doc.widthOfString(text)) * 100;
  };

  // "FRÁGIL": preenche ~96% da largura, mas nunca mais alto que ~55% da área.
  const fragilSize = Math.min(maxFontForWidth('FRÁGIL', 'Helvetica-Bold', usableW * 0.96), warnH * 0.55);
  // "PRODUTO": ~42% do tamanho do FRÁGIL (menor, mas negrito), sempre cabendo.
  const produtoSize = Math.min(fragilSize * 0.42, maxFontForWidth('PRODUTO', 'Helvetica-Bold', usableW * 0.9));

  // Centraliza o par (PRODUTO + espaço + FRÁGIL) verticalmente na área do aviso.
  const gap = fragilSize * 0.12;
  const blockH = produtoSize + gap + fragilSize;
  let fy = warnTop + (warnH - blockH) / 2;

  doc.fillColor('black').font('Helvetica-Bold');
  doc.fontSize(produtoSize);
  doc.text('PRODUTO', 8, fy, { width: usableW, align: 'center', lineBreak: false });
  fy += produtoSize + gap;
  doc.fontSize(fragilSize);
  doc.text('FRÁGIL', 8, fy, { width: usableW, align: 'center', lineBreak: false });

  // Data/hora
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR');
  doc.fontSize(11).font('Helvetica');
  doc.text(`${dateStr} ${timeStr}`, 8, warnBottom + 6, {
    width: usableW,
    align: 'center',
  });

  // Footer (mensagem mantida, sem alteração)
  doc.fontSize(12).font('Helvetica-Bold');
  doc.text('PRODUTO EMBALADO', 8, warnBottom + 26, { width: usableW, align: 'center' });
  doc.fontSize(11).font('Helvetica');
  doc.text('COM TODOS OS PADRÕES', 8, warnBottom + 40, { width: usableW, align: 'center' });
  doc.text('DE QUALIDADE E SEGURANÇA', 8, warnBottom + 53, { width: usableW, align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
    doc.on('error', reject);
  });
}

module.exports = { generateLabelPDF };
