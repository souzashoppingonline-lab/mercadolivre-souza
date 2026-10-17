// Nome do arquivo baixado do vídeo de devolução/embalagem (routes/devolucaoVideos.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { nomeDownload } = require('../src/routes/devolucaoVideos');

test('nome legível com reclamação, pedido, data e extensão pelo formato gravado', () => {
  assert.strictEqual(nomeDownload({ claim_id: '5300111', order_id: '2000012345', created_at: '2026-10-17T10:00:00Z', mime: 'video/mp4' }),
    'devolucao_reclamacao_5300111_pedido_2000012345_2026-10-17.mp4');
  assert.strictEqual(nomeDownload({ order_id: '2000012345', created_at: '2026-10-01T10:00:00Z', file_path: '/x/a.webm' }, 'embalagem'),
    'embalagem_pedido_2000012345_2026-10-01.webm');
  // nada de caractere perigoso no nome (vai no Content-Disposition)
  assert.match(nomeDownload({ claim_id: '../"x;', order_id: 'a b', created_at: '2026-10-17', mime: 'video/webm' }), /^devolucao_reclamacao_x_pedido_ab_2026-10-17\.webm$/);
});
