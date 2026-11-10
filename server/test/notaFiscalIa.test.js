const test = require('node:test');
const assert = require('node:assert');
const { normalizarLeitura, lerValor, lerData, formatarDoc } = require('../src/notaFiscalIa');

const HOJE = new Date(2026, 10, 10); // 10/11/2026
const CATS = [{ id: 7, name: 'Combustível' }, { id: 9, name: 'Material de Embalagem' }];

test('valor: formatos brasileiros e números', () => {
  assert.strictEqual(lerValor('1.234,56'), 1234.56);
  assert.strictEqual(lerValor('R$ 99,90'), 99.9);
  assert.strictEqual(lerValor('1234.5'), 1234.5);
  assert.strictEqual(lerValor(78.999), 79);
  assert.strictEqual(lerValor(0), null);
  assert.strictEqual(lerValor('abc'), null);
  assert.strictEqual(lerValor(null), null);
});

test('data: AAAA-MM-DD, DD/MM/AAAA, impossível e fora da janela', () => {
  assert.strictEqual(lerData('2026-11-08', HOJE), '2026-11-08');
  assert.strictEqual(lerData('08/11/2026', HOJE), '2026-11-08');
  assert.strictEqual(lerData('31/02/2026', HOJE), null);
  assert.strictEqual(lerData('2019-01-01', HOJE), null);   // mais de 2 anos atrás
  assert.strictEqual(lerData('2027-06-01', HOJE), null);   // muito no futuro
  assert.strictEqual(lerData(null, HOJE), null);
});

test('CNPJ/CPF formatado', () => {
  assert.strictEqual(formatarDoc('12345678000195'), '12.345.678/0001-95');
  assert.strictEqual(formatarDoc('123.456.789-01'), '123.456.789-01');
  assert.strictEqual(formatarDoc('123'), null);
});

test('leitura completa: categoria por id, por nome, inexistente', () => {
  const r = normalizarLeitura({ valor_total: '250,00', data: '08/11/2026', fornecedor: '  Posto   Avenida  ', cnpj: '12345678000195',
    descricao: 'Combustível', categoria_id: 7, tipo: 'operational', legivel: true, observacao: null }, CATS, HOJE);
  assert.deepStrictEqual(r, { valor: 250, data: '2026-11-08', fornecedor: 'Posto Avenida', cnpj: '12.345.678/0001-95',
    descricao: 'Combustível', categoria_id: 7, categoria_nome: 'Combustível', tipo: 'operational', legivel: true, observacao: null });
  assert.strictEqual(normalizarLeitura({ valor_total: 10, categoria_id: 'material de embalagem' }, CATS, HOJE).categoria_id, 9);
  assert.strictEqual(normalizarLeitura({ valor_total: 10, categoria_id: 99 }, CATS, HOJE).categoria_id, null);
  assert.strictEqual(normalizarLeitura({ valor_total: 10, tipo: 'fixed' }, CATS, HOJE).tipo, 'fixed');
  assert.strictEqual(normalizarLeitura({ valor_total: 10, tipo: 'qualquer' }, CATS, HOJE).tipo, 'operational');
});

test('ilegível: sem valor ou a IA disse que não leu', () => {
  assert.strictEqual(normalizarLeitura({ valor_total: null, legivel: true }, CATS, HOJE).legivel, false);
  assert.strictEqual(normalizarLeitura({ valor_total: 50, legivel: false }, CATS, HOJE).legivel, false);
  assert.strictEqual(normalizarLeitura(null, CATS, HOJE).legivel, false);
});
