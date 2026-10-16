// Texto do aviso de pagamento no Telegram (server/src/avisoPagamento.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { textoAvisoPagamento: T } = require('../src/avisoPagamento');

test('boleto pago: nome, valor, conta, empresa, vencimento e quanto falta de hoje', () => {
  const t = T({ nome: 'BOLETO MARTINS', valor: 1219.02, conta: 'Itaú Unifull', empresa: 'UNIFULL', vencimento: '2026-10-16', faltam_hoje: { n: 2, valor: 4819 } });
  assert.match(t, /^✅ <b>Conta paga<\/b> — BOLETO MARTINS/);
  assert.match(t, /💰 <b>R\$\s1\.219,02<\/b> · 🏦 Itaú Unifull/);
  assert.match(t, /🏢 UNIFULL · vence 16\/10/);
  assert.match(t, /📅 Hoje ainda faltam 2 contas — R\$\s4\.819,00/);
});

test('atrasada, última de hoje, fatura e desfeito', () => {
  assert.match(T({ nome: 'ALUGUEL', valor: 2000, vencimento: '2026-10-10', atrasada: true, faltam_hoje: { n: 0, valor: 0 } }), /⚠️ estava atrasada \(venceu 10\/10\)[\s\S]*🎉 Todas as contas de hoje pagas!/);
  assert.match(T({ nome: 'Fatura MERCADO PAGO', valor: 300, fatura: true, parcelas: 3, empresa: '💳 Cartões' }), /^💳 <b>Fatura paga<\/b> — Fatura MERCADO PAGO \(3 parcelas\)/);
  assert.doesNotMatch(T({ nome: 'Fatura X', valor: 1, fatura: true, empresa: '💳 Cartões' }), /🏢/);
  assert.match(T({ nome: 'QUATREE', valor: 10, desfeito: true }), /^↩️ <b>Pagamento desfeito<\/b> — QUATREE\n💰 R\$\s10,00 voltou pra <b>a pagar<\/b>/);
});

test('escapa HTML e corta texto enorme (vem do navegador)', () => {
  const t = T({ nome: '<b>A&B</b>' + 'x'.repeat(500), valor: 'abc', conta: '<script>' });
  assert.match(t, /&lt;b&gt;A&amp;B&lt;\/b&gt;/);
  assert.ok(!t.includes('<script>'));
  assert.ok(t.length < 400);
  assert.match(t, /R\$\s0,00/);
});
