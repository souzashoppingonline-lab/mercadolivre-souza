// Extrato Bancário (OFX): leitor (ofx.js), categorias (ofxCategorias.js) e análise (ofxAnalise.js).
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (/db\/pool$/.test(req)) return {};
  return orig.apply(this, arguments);
};
const { lerOfx, valorOfx, dataOfx } = require('../src/ofx');
const { contraparte, classificar, categoriaPorPalavra } = require('../src/ofxCategorias');
const { resumoMes } = require('../src/ofxAnalise');
Module._load = orig;

// OFX 1.x (SGML) no estilo do Santander: tags sem fechamento, valor com vírgula, latin1.
const SGML = Buffer.from([
  'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'ENCODING:USASCII', 'CHARSET:1252', '',
  '<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>BANCO TESTE<FID>999</FI></SONRS></SIGNONMSGSRSV1>',
  '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>033<ACCTID>123456789<ACCTTYPE>CHECKING</BANKACCTFROM>',
  '<BANKTRANLIST><DTSTART>20260901000000[-3:GMT]<DTEND>20260930000000[-3:GMT]',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901000000[-3:GMT]<TRNAMT>-1.234,50<FITID>A1<MEMO>Pagamento De Boleto Outros Bancos ARMAZÉNS TESTE</STMTTRN>',
  '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260902<TRNAMT>500,00<FITID>A2<MEMO>Pix Recebido 12345678000190',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-10,00<FITID>A3<MEMO>Tarifa Pix</STMTTRN>',
  '</BANKTRANLIST><LEDGERBAL><BALAMT>1000,00<DTASOF>20261101000113[-3:GMT]</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
].join('\r\n'), 'latin1');

// OFX 2.x (XML), valor com ponto, NAME + MEMO.
const XML = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="211"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKACCTFROM><BANKID>0341</BANKID><BRANCHID>1234</BRANCHID><ACCTID>55667-8</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>2500.75</TRNAMT><FITID>X1</FITID><NAME>MERCADO PAGO IP LTDA</NAME><MEMO>TRANSF</MEMO></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>3000.00</BALAMT><DTASOF>20261031</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`, 'utf8');

test('lê OFX 1.x (SGML, latin1, vírgula decimal, STMTTRN sem fechar)', () => {
  const r = lerOfx(SGML);
  assert.strictEqual(r.banco_nome, 'BANCO TESTE');
  const c = r.contas[0];
  assert.deepStrictEqual([c.banco_id, c.conta, c.dt_inicio, c.dt_fim, c.saldo_final], ['033', '123456789', '2026-09-01', '2026-09-30', 1000]);
  assert.strictEqual(c.lancamentos.length, 3);
  assert.deepStrictEqual(c.lancamentos.map((l) => l.valor), [-1234.5, 500, -10]);
  assert.match(c.lancamentos[0].memo, /ARMAZÉNS TESTE/);
});

test('lê OFX 2.x (XML) com agência, NAME e MEMO', () => {
  const c = lerOfx(XML).contas[0];
  assert.deepStrictEqual([c.banco_id, c.agencia, c.conta, c.saldo_final], ['0341', '1234', '55667-8', 3000]);
  assert.deepStrictEqual(c.lancamentos[0], { fitid: 'X1', tipo: 'CREDIT', data: '2026-10-05', valor: 2500.75, nome: 'MERCADO PAGO IP LTDA', memo: 'TRANSF', checknum: null, ordem: 0 });
});

test('arquivo que não é OFX dá erro claro', () => {
  assert.throws(() => lerOfx(Buffer.from('data;valor\n01/09;10')), /não parece um OFX/);
});

test('valores e datas no formato dos bancos', () => {
  assert.strictEqual(valorOfx('-1.234,56'), -1234.56);
  assert.strictEqual(valorOfx('-1234.56'), -1234.56);
  assert.strictEqual(valorOfx('0,03'), 0.03);
  assert.strictEqual(dataOfx('20261031120000[-3:BRT]'), '2026-10-31');
});

test('contraparte: tira operação, data/hora e repetição do banco', () => {
  assert.deepStrictEqual(contraparte('Pix Enviado LIN RAN VARIEDADES DOMEST'), { op: 'PIX_ENV', nome: 'LIN RAN VARIEDADES DOMEST', chave: 'PIX_ENV|LIN RAN VARIEDADES DOMEST' });
  assert.strictEqual(contraparte('Pix Recebido 53727812000108').nome, 'CNPJ 53.727.812/0001-08');
  assert.strictEqual(contraparte('Pagamento Cartao Credito Bce 01/09 14:34 CARTAO MASTER').nome, 'CARTAO MASTER');
  assert.strictEqual(contraparte('Rendimento Liquido De Contamax 7000 RENDIMENTO LIQUIDO DE CONTAMAX').nome, 'RENDIMENTO LIQUIDO DE CONTAMAX 7000');
});

test('categorias automáticas', () => {
  const c = (d, v) => categoriaPorPalavra(d, v);
  assert.strictEqual(c('Pagamento De Boleto Outros Bancos ARMAZENS MARTINS', -100), 'fornecedores');
  assert.strictEqual(c('Pagamento Darf Em Canais INTERNET SIMPLES NACIONAL', -100), 'impostos');
  assert.strictEqual(c('Pix Enviado BANCO INTER S A', -100), 'entre_contas');
  assert.strictEqual(c('Pix Enviado PEX TA ENTREGUE LOGISTICA', -100), 'frete');
  assert.strictEqual(c('Pagamento De Boleto Outros Bancos MULTIPLA CONTABILIDADE E', -100), 'servicos');
  assert.strictEqual(c('Tarifa Pix', -10), 'tarifas');
  assert.strictEqual(c('Pix Recebido 53727812000108', 100), 'pix_recebido');
  assert.strictEqual(c('TED MERCADO PAGO IP LTDA', 100), 'repasse_marketplace');
  assert.strictEqual(c('Pix Enviado SUELEN SOUZA BARROS', -100), 'sem_categoria'); // pessoa: o usuário ensina
});

test('regra aprendida vence a palavra-chave e troca o nome', () => {
  const regras = new Map([['PIX_REC|53727812000108', { categoria: 'repasse_marketplace', apelido: 'Mercado Pago' }]]);
  assert.deepStrictEqual(classificar('Pix Recebido 53727812000108', 100, regras),
    { categoria: 'repasse_marketplace', origem: 'aprendido', contraparte: 'Mercado Pago', contraparte_chave: 'PIX_REC|53727812000108' });
});

const L = (id, data, valor, categoria, cp, origem = 'auto') => ({ id, data, valor, categoria, contraparte: cp, contraparte_chave: cp, categoria_origem: origem });

test('resumo: totais sem "entre contas", saldo dia a dia, tarifas e alertas', () => {
  const lancs = [
    L(1, '2026-09-01', 10000, 'repasse_marketplace', 'MP'),
    L(2, '2026-09-02', -3000, 'fornecedores', 'ALFA'),
    L(3, '2026-09-02', -3000, 'fornecedores', 'ALFA'),           // em dobro
    L(4, '2026-09-03', -2000, 'entre_contas', 'BANCO INTER'),    // fora do total
    L(5, '2026-09-04', -50, 'tarifas', 'TARIFA'),
    L(6, '2026-09-05', -900, 'sem_categoria', 'FULANO'),
  ];
  const r = resumoMes({ mes: '2026-09', lancs, saldoRef: { valor: 4050, data: '2026-09-30' } });
  assert.deepStrictEqual([r.totais.entradas, r.totais.saidas, r.totais.resultado], [10000, 6950, 3050]);
  assert.strictEqual(r.saldo.final, 4050);
  assert.strictEqual(r.saldo.inicial, 3000);           // 4050 − (10000 − 6000 − 2000 − 50 − 900)
  assert.strictEqual(r.saldo.dias.find((d) => d.data === '2026-09-02').saldo, 7000);
  assert.strictEqual(r.tarifas.total, 50);
  const tipos = r.alertas.map((a) => a.tipo);
  assert.ok(tipos.includes('duplicado') && tipos.includes('saldo_baixo') && tipos.includes('confirmar_entre_contas') && tipos.includes('sem_categoria'));
  assert.strictEqual(r.categorias.saidas.find((c) => c.categoria === 'entre_contas').fora, true);
  assert.strictEqual(r.destinatarios[0].nome, 'ALFA');
});

test('resumo: extrato até o meio do mês → dias depois sem saldo', () => {
  const r = resumoMes({ mes: '2026-11', lancs: [L(1, '2026-11-03', 100, 'clientes', 'X')], saldoRef: { valor: 500, data: '2026-11-15' } });
  assert.strictEqual(r.saldo.dias.find((d) => d.data === '2026-11-20').saldo, null);
  assert.strictEqual(r.saldo.dias.find((d) => d.data === '2026-11-15').saldo, 500);
  assert.strictEqual(r.saldo.dias.find((d) => d.data === '2026-11-02').saldo, 400);
});

test('resumo: recorrentes, comparação e fora do padrão usam os meses anteriores', () => {
  const anteriores = [
    L(11, '2026-06-05', -6800, 'aluguel', 'ALUGUEL'), L(12, '2026-07-05', -6800, 'aluguel', 'ALUGUEL'), L(13, '2026-08-05', -6800, 'aluguel', 'ALUGUEL'),
    L(14, '2026-06-10', -50, 'tarifas', 'PACOTE'), L(15, '2026-07-10', -52, 'tarifas', 'PACOTE'), L(16, '2026-08-10', -51, 'tarifas', 'PACOTE'),
    L(17, '2026-08-20', 8000, 'clientes', 'C'),
  ];
  const lancs = [L(1, '2026-09-05', -6800, 'aluguel', 'ALUGUEL'), L(2, '2026-09-10', -389, 'tarifas', 'PACOTE'), L(3, '2026-09-15', 10000, 'clientes', 'C')];
  const r = resumoMes({ mes: '2026-09', lancs, anteriores });
  assert.strictEqual(r.recorrentes[0].nome, 'ALUGUEL');
  assert.strictEqual(r.recorrentes[0].meses, 4);
  assert.strictEqual(r.totais.var_entradas_pct, 25);
  assert.ok(r.alertas.some((a) => a.tipo === 'fora_padrao' && a.nome === 'PACOTE' && a.valor === 389));
});

test('mês de competência: conta paga sáb 31/10 e compensada seg 03/11 conta em outubro, saldo segue o banco', () => {
  const pago = { ...L(9, '2026-11-03', -500, 'fornecedores', 'ALFA'), mes_competencia: '2026-10' };
  const outubro = resumoMes({ mes: '2026-10', lancs: [L(1, '2026-10-10', 1000, 'clientes', 'C'), pago],
    lancsPorData: [L(1, '2026-10-10', 1000, 'clientes', 'C')], saldoRef: { valor: 1000, data: '2026-10-31' } });
  assert.strictEqual(outubro.totais.saidas, 500);                 // entra no total de outubro
  assert.strictEqual(outubro.saldo.final, 1000);                  // mas o saldo de 31/10 do banco não muda
  assert.strictEqual(outubro.periodo.vindos_de_outro_mes, 1);
  const novembro = resumoMes({ mes: '2026-11', lancs: [], lancsPorData: [pago] });
  assert.strictEqual(novembro.totais.saidas, 0);                  // sai do total de novembro
  assert.strictEqual(novembro.saldo.dias.find((d) => d.data === '2026-11-03').saidas, 500); // gráfico do banco mantém
  assert.strictEqual(novembro.periodo.contados_em_outro_mes, 1);
});
