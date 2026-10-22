// Leitura de código de boleto/PIX (js/boletoCodigo.js) — página Dívidas do Dia.
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../../js/boletoCodigo');

const dias = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
function bancario(banco, venc, valor, livre = '1234567890123456789012345') {
  const fator = String(1000 + dias(venc, '2025-02-22')).padStart(4, '0');
  const sem = `${banco}9${fator}${String(Math.round(valor * 100)).padStart(10, '0')}${livre}`;
  return sem.slice(0, 4) + C.mod11Bancario(sem) + sem.slice(4);
}
function arrecadacao(valor, id = '6') {
  const sem = `83${id}${String(Math.round(valor * 100)).padStart(11, '0')}${'0'.repeat(4)}${'98765432101234567890123456789'.slice(0, 25)}`;
  const f = ['6', '7'].includes(id) ? C.mod10 : C.mod11Arrecadacao;
  return sem.slice(0, 3) + f(sem) + sem.slice(3);
}
function pix(valor) {
  const t = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const s = t('00', '01') + t('26', t('00', 'br.gov.bcb.pix') + t('01', '12345678909')) + t('52', '0000') + t('53', '986') + (valor ? t('54', valor.toFixed(2)) : '') + t('58', 'BR') + t('59', 'MARTINS ATACADO') + t('60', 'UBERLANDIA') + t('62', t('05', '***')) + '6304';
  return s + C.crc16(s);
}

test('bancário: código de 44 e linha de 47 dão o mesmo resultado; vencimento e valor certos', () => {
  const bc = bancario('341', '2026-10-16', 1219.02);
  assert.strictEqual(bc.length, 44);
  const a = C.ler(bc, '2026-10-10');
  assert.deepStrictEqual([a.ok, a.tipo, a.banco, a.bancoNome, a.valor, a.vencimento], [true, 'bancario', '341', 'Itaú', 1219.02, '2026-10-16']);
  assert.strictEqual(a.linha.length, 47);
  const b = C.ler(a.linhaFormatada, '2026-10-10'); // digitada com pontos/espaços
  assert.strictEqual(b.codigo, bc);
  assert.match(a.linhaFormatada, /^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);
});

test('fator de vencimento: ciclo novo (1000 = 22/02/2025), antigo e sem vencimento', () => {
  assert.strictEqual(C.vencimentoDoFator(1000, '2026-10-16'), '2025-02-22');
  assert.strictEqual(C.vencimentoDoFator(9999, '2025-01-10'), '2025-02-21');
  assert.strictEqual(C.vencimentoDoFator(0, '2026-10-16'), null);
});

test('recusa leitura errada (dígito trocado) e tamanho estranho', () => {
  const bc = bancario('001', '2026-11-05', 99.9);
  // DV geral trocado: sempre recusa. (Trocar um dígito qualquer do meio às
  // vezes passa — o DV bancário junta os restos 0/10/11 em "1"; por isso a
  // câmera só aceita depois de 2 leituras iguais seguidas.)
  const errado = bc.slice(0, 4) + ((Number(bc[4]) + 1) % 10) + bc.slice(5);
  assert.strictEqual(C.ler(errado, '2026-10-16').ok, false);
  const l = C.ler(bc, '2026-10-16').linha;
  assert.strictEqual(C.ler(l.slice(0, 3) + ((Number(l[3]) + 1) % 10) + l.slice(4), '2026-10-16').ok, false);
  assert.match(C.ler('123', '2026-10-16').erro, /3 dígitos/);
});

test('arrecadação (conta de luz/imposto): valor sim, vencimento não; 48 dígitos ida e volta', () => {
  for (const id of ['6', '8']) {
    const bc = arrecadacao(87.35, id);
    const a = C.ler(bc, '2026-10-16');
    assert.deepStrictEqual([a.ok, a.tipo, a.valor, a.vencimento, a.segmento], [true, 'arrecadacao', 87.35, null, 'Energia/gás']);
    assert.strictEqual(a.linha.length, 48);
    assert.strictEqual(C.ler(a.linhaFormatada, '2026-10-16').codigo, bc);
  }
});

test('PIX copia-e-cola: valor, recebedor e CRC', () => {
  const p = C.ler(pix(450.5), '2026-10-16');
  assert.deepStrictEqual([p.ok, p.tipo, p.valor, p.recebedor, p.chave], [true, 'pix', 450.5, 'MARTINS ATACADO', '12345678909']);
  assert.strictEqual(C.ler(pix(0), '2026-10-16').valor, 0);
  const s = pix(10); assert.strictEqual(C.ler(s.slice(0, -1) + (s.endsWith('0') ? '1' : '0'), '2026-10-16').ok, false);
});

test('procurar: código salvo > valor+vencimento > valor a confirmar; pagas avisam; cartão fica fora', () => {
  const bc = bancario('341', '2026-10-16', 1219.02);
  const L = C.ler(bc, '2026-10-16');
  const B = (id, date, value, extra = {}) => ({ id, name: id, date, value, status: 'pendente', tipo: 'boleto', ...extra });
  const boletos = [B('certo', '2026-10-16', 1219.02), B('longe', '2026-11-30', 1219.02), B('perto', '2026-10-18', 1219.02),
    B('zero', '2026-10-15', 0), B('cartao', '2026-10-16', 1219.02, { tipo: 'cartao' }), B('paga', '2026-10-16', 1219.02, { status: 'pago' })];
  const r = C.procurar(boletos, L);
  assert.deepStrictEqual(r.opcoes.map(o => [o.boleto.id, o.motivo]), [['certo', 'valor'], ['perto', 'valor'], ['zero', 'valor_a_confirmar']]);
  assert.deepStrictEqual(r.jaPagas.map(b => b.id), ['paga']);
  // código salvo manda
  const r2 = C.procurar([...boletos, B('salvo', '2026-12-01', 5, { codigo_barras: bc })], L);
  assert.deepStrictEqual(r2.opcoes.map(o => o.boleto.id), ['salvo']);
  // sem vencimento no código (arrecadação): qualquer data com o mesmo valor
  const A = C.ler(arrecadacao(87.35), '2026-10-16');
  assert.deepStrictEqual(C.procurar([B('luz', '2026-12-20', 87.35), B('outra', '2026-10-16', 80)], A).opcoes.map(o => o.boleto.id), ['luz']);
});
