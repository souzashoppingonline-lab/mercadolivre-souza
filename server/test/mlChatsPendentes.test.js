const test = require('node:test');
const assert = require('node:assert');
const { lerNaoLidas } = require('../src/mlChatsPendentes');

test('lê o formato documentado do ML', () => {
  assert.deepStrictEqual(lerNaoLidas({ results: [{ resource: '/packs/2000004567/sellers/123', count: 2 }, { resource: '/packs/2000009999/sellers/123', count: 1 }] }),
    [{ pack: '2000004567', n: 2 }, { pack: '2000009999', n: 1 }]);
});
test('lista vazia = nada sem leitura (zera)', () => {
  assert.deepStrictEqual(lerNaoLidas({ results: [] }), []);
});
test('aceita array solto e pack_id/unread', () => {
  assert.deepStrictEqual(lerNaoLidas([{ pack_id: 55, unread: 3 }]), [{ pack: '55', n: 3 }]);
});
test('formato desconhecido → null (não zera nada)', () => {
  assert.strictEqual(lerNaoLidas({ message: 'error' }), null);
  assert.strictEqual(lerNaoLidas(null), null);
});
