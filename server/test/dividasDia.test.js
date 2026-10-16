// js/dividasDia.js no Node (o worker.js reusa o cálculo da página pro push das
// 07:00): textoNotificacao a partir do MESMO calcular() da página.
const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../../js/dividasDia');

const B = (id, name, date, value, status = 'pendente') => ({ id, name, date, value, status, tipo: 'boleto', empresa: 'UNIFULL' });

test('carrega no Node sem window e expõe o mesmo API da página', () => {
  assert.strictEqual(typeof D.calcular, 'function');
  assert.strictEqual(typeof D.textoNotificacao, 'function');
});

test('vencem hoje + atrasadas: título com quantidade e total, corpo com nomes e atrasadas', () => {
  const r = D.calcular({ hoje: '2026-10-16', boletos: [
    B('1', 'BOLETO MARTINS', '2026-10-16', 1000), B('2', 'QUATREE', '2026-10-16', 500.5), B('3', 'SANOL', '2026-10-16', 10),
    B('4', 'ALUGUEL', '2026-10-10', 2000), B('5', 'PAGO', '2026-10-16', 99, 'pago'), B('6', 'FUTURO', '2026-10-17', 1),
  ] });
  const n = D.textoNotificacao(r);
  assert.match(n.title, /^💸 3 contas vencem hoje — R\$\s1\.510,50$/);
  assert.match(n.body, /BOLETO MARTINS, QUATREE e \+1/);
  assert.match(n.body, /⚠️ 1 atrasada \(R\$\s2\.000,00\)/);
});

test('só atrasadas; uma conta só no singular; nada a pagar → null', () => {
  assert.match(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('4', 'ALUGUEL', '2026-10-10', 2000)] })).title, /^⚠️ 1 conta atrasada — /);
  assert.match(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('1', 'LUZ', '2026-10-16', 80)] })).title, /^💸 1 conta vence hoje/);
  assert.strictEqual(D.textoNotificacao(D.calcular({ hoje: '2026-10-16', boletos: [B('6', 'FUTURO', '2026-10-17', 1)] })), null);
});

test('lembrete das 19:00: só quando sobrou conta de HOJE; atrasadas entram como complemento', () => {
  const r = D.calcular({ hoje: '2026-10-16', boletos: [B('1', 'EMPRESTIMO ML', '2026-10-16', 3600), B('2', 'BOLETO MARTINS', '2026-10-16', 1219.02), B('4', 'ALUGUEL', '2026-10-10', 2000)] });
  const n = D.textoLembrete(r);
  assert.match(n.title, /^⏰ Ainda faltam 2 contas de hoje — R\$\s4\.819,02$/);
  assert.match(n.body, /EMPRESTIMO ML e BOLETO MARTINS\n⚠️ \+ 1 atrasada/);
  assert.match(D.textoLembrete(D.calcular({ hoje: '2026-10-16', boletos: [B('1', 'LUZ', '2026-10-16', 80)] })).title, /^⏰ Ainda falta 1 conta de hoje/);
  // só atrasada (nada de hoje) → sem lembrete; tudo de hoje pago → sem lembrete
  assert.strictEqual(D.textoLembrete(D.calcular({ hoje: '2026-10-16', boletos: [B('4', 'ALUGUEL', '2026-10-10', 2000)] })), null);
  assert.strictEqual(D.textoLembrete(D.calcular({ hoje: '2026-10-16', boletos: [B('1', 'LUZ', '2026-10-16', 80, 'pago')] })), null);
});

test('calendário do mês: semanas dom→sáb, totais por dia, peso, atrasada, tudo pago, semana mais pesada', () => {
  const c = D.calendarioMes({ hoje: '2026-10-16', mes: '2026-10', boletos: [
    B('1', 'A', '2026-10-16', 1000), B('2', 'B', '2026-10-16', 500), B('3', 'C', '2026-10-10', 300),
    B('4', 'D', '2026-10-05', 200, 'pago'), B('5', 'E', '2026-10-28', 750), B('6', 'FORA', '2026-11-01', 9999),
  ] });
  assert.strictEqual(c.fim, '2026-10-31');
  assert.strictEqual(c.semanas.length, 5);                       // 01/10/2026 é quinta
  assert.deepStrictEqual(c.semanas[0].dias.slice(0, 4).map(d => !!d.foraDoMes), [true, true, true, true]);
  assert.strictEqual(c.semanas[0].de, '2026-10-01');
  const dia = d => c.semanas.flatMap(w => w.dias).find(x => x.date === d);
  assert.strictEqual(dia('2026-10-16').aPagar, 1500);
  assert.strictEqual(dia('2026-10-16').peso, 1);
  assert.strictEqual(dia('2026-10-28').peso, 0.5);
  assert.strictEqual(dia('2026-10-10').atrasada, true);
  assert.strictEqual(dia('2026-10-05').tudoPago, true);
  assert.strictEqual(c.max, 1500);
  assert.deepStrictEqual(c.semanas.filter(w => w.maisPesada).map(w => [w.de, w.ate]), [['2026-10-11', '2026-10-17']]);
  assert.ok(!c.itens.some(i => i.nome === 'FORA'));
  // dezembro: 31 dias, último dia certo
  assert.strictEqual(D.calendarioMes({ hoje: '2026-10-16', mes: '2026-12' }).fim, '2026-12-31');
  assert.strictEqual(D.calendarioMes({ hoje: '2026-10-16', mes: '2027-02' }).fim, '2027-02-28');
});
