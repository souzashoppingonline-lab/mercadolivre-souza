const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/tributario');

const det = (n, { vProd, cst, csosn, vICMS = 0, vICMSST = 0, vBCST = 0, vCred = 0, pisCst = '01', vDesc = 0 }) => {
  const grupo = csosn ? `ICMSSN${csosn}` : `ICMS${cst}`;
  const codigo = csosn ? `<CSOSN>${csosn}</CSOSN>` : `<CST>${cst}</CST>`;
  return `<det nItem="${n}"><prod><cProd>P${n}</cProd><xProd>Produto ${n}</xProd><NCM>23091000</NCM><CFOP>5102</CFOP><vProd>${vProd.toFixed(2)}</vProd>${vDesc ? `<vDesc>${vDesc.toFixed(2)}</vDesc>` : ''}</prod>
  <imposto><ICMS><${grupo}><orig>0</orig>${codigo}${vICMS ? `<vBC>${vProd}</vBC><pICMS>18.00</pICMS><vICMS>${vICMS.toFixed(2)}</vICMS>` : ''}${vBCST ? `<vBCST>${vBCST}</vBCST>` : ''}${vICMSST ? `<vICMSST>${vICMSST.toFixed(2)}</vICMSST>` : ''}${vCred ? `<pCredSN>2.50</pCredSN><vCredICMSSN>${vCred.toFixed(2)}</vCredICMSSN>` : ''}</${grupo}></ICMS>
  <PIS><PISAliq><CST>${pisCst}</CST></PISAliq></PIS></imposto></det>`;
};
const nfe = ({ crt, cnpj, nome, itens, vNF, emissao = '2026-10-10' }) => `<?xml version="1.0"?><nfeProc><NFe><infNFe versao="4.00" Id="NFe35261012345678000195550010000012341000012345">
<ide><nNF>1234</nNF><dhEmi>${emissao}T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${cnpj}</CNPJ><xNome>${nome}</xNome><enderEmit><UF>SP</UF></enderEmit><CRT>${crt}</CRT></emit>
<dest><CNPJ>53727812000108</CNPJ><enderDest><UF>SP</UF></enderDest></dest>
${itens.join('\n')}
<total><ICMSTot><vBC>0</vBC><vICMS>0</vICMS><vST>0</vST><vProd>0</vProd><vDesc>0</vDesc><vNF>${vNF.toFixed(2)}</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;

// Fornecedor regime normal: item tributado (ICMS 18), item com ST (CST 60) e item monofásico de PIS (CST 04).
const XML_NORMAL = nfe({ crt: 3, cnpj: '11111111000111', nome: 'DISTRIBUIDORA NORMAL', vNF: 1000, itens: [
  det(1, { vProd: 500, cst: '00', vICMS: 90 }),
  det(2, { vProd: 300, cst: '60' }),
  det(3, { vProd: 200, cst: '00', vICMS: 36, pisCst: '04' }),
] });
// Fornecedor Simples: CSOSN 101 (informa crédito) e 500 (ST).
const XML_SIMPLES = nfe({ crt: 1, cnpj: '22222222000122', nome: 'LOJA SIMPLES ME', vNF: 400, itens: [
  det(1, { vProd: 200, csosn: '101', vCred: 5, pisCst: '99' }),
  det(2, { vProd: 200, csosn: '500', pisCst: '99' }),
] });

test('Simples Anexo I: faixa e alíquota efetiva', () => {
  const a = t.faixaSimples(150000);
  assert.strictEqual(a.faixa, 1); assert.strictEqual(a.efetiva, 4);
  const b = t.faixaSimples(850000);     // (850000×10,7% − 22500) / 850000 = 8,05%
  assert.strictEqual(b.faixa, 4); assert.strictEqual(b.efetiva, 8.05); assert.strictEqual(b.falta_proxima, 950000);
  const c = t.faixaSimples(1945000);    // (1945000×14,3% − 87300) / 1945000 = 9,81%
  assert.strictEqual(c.faixa, 5); assert.strictEqual(c.efetiva, 9.81); assert.strictEqual(c.acima_sublimite, false);
  assert.strictEqual(t.faixaSimples(3700000).acima_sublimite, true);
  assert.strictEqual(t.faixaSimples(5000000).acima_teto, true);
  assert.strictEqual(t.faixaSimples(0).faixa, 1);
});

test('estados: nome → UF e alíquota interestadual saindo de SP', () => {
  assert.strictEqual(t.ufDe('São Paulo'), 'SP');
  assert.strictEqual(t.ufDe('sao paulo'), 'SP');
  assert.strictEqual(t.ufDe('BR-RJ'), 'RJ');
  assert.strictEqual(t.ufDe('Espírito Santo'), 'ES');
  assert.strictEqual(t.ufDe(''), null);
  assert.strictEqual(t.ufDe('Atlântida'), null);
  assert.strictEqual(t.aliquotaInterestadualSP('SP'), null);
  assert.strictEqual(t.aliquotaInterestadualSP('MG'), 12);
  assert.strictEqual(t.aliquotaInterestadualSP('ES'), 7);
  assert.strictEqual(t.aliquotaInterestadualSP('BA'), 7);
});

test('NF-e de fornecedor do regime normal: crédito = ICMS destacado; ST e PIS monofásico sem crédito', () => {
  const n = t.parseNfe(XML_NORMAL);
  assert.strictEqual(n.chave.length, 44);
  assert.strictEqual(n.emitente.crt, '3');
  assert.strictEqual(n.itens.length, 3);
  assert.strictEqual(n.itens[1].icms.cst, '60');
  const c = t.creditosNota(n);
  assert.strictEqual(c.regime_normal, true);
  assert.strictEqual(c.credito_icms, 126);          // 90 + 36 (o item ST não tem ICMS destacado)
  assert.strictEqual(c.itens_st, 1);
  assert.strictEqual(c.base_pis_cofins, 800);       // 500 + 300 (o monofásico, CST 04, fica de fora)
  assert.strictEqual(c.credito_pis_cofins, 74);     // 800 × 9,25%
});

test('NF-e de fornecedor do Simples: crédito = vCredICMSSN; CSOSN 500 é ST', () => {
  const c = t.creditosNota(t.parseNfe(XML_SIMPLES));
  assert.strictEqual(c.regime, 'Simples Nacional');
  assert.strictEqual(c.credito_icms, 5);
  assert.strictEqual(c.itens_st, 1);
  assert.strictEqual(c.credito_pis_cofins, 37);     // 400 × 9,25% (PIS 99 do Simples gera crédito no Real)
});

test('resumo por fornecedor + semáforo', () => {
  const notas = [XML_NORMAL, XML_SIMPLES, XML_NORMAL].map((x) => { const n = t.parseNfe(x); return { ...n, creditos: t.creditosNota(n) }; });
  const r = t.resumoFornecedores(notas);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].nome, 'DISTRIBUIDORA NORMAL');   // maior compra primeiro
  assert.strictEqual(r[0].notas, 2);
  assert.strictEqual(r[0].total_compras, 2000);
  assert.strictEqual(r[0].credito_icms, 252);
  assert.strictEqual(r[0].pct_credito_icms, 12.6);
  assert.strictEqual(r[0].semaforo, 'verde');
  assert.strictEqual(r[1].semaforo, 'amarelo');            // 5 / 400 = 1,25%
  assert.strictEqual(r[1].pct_itens_st, 50);
});

test('XML inválido', () => {
  assert.throws(() => t.parseNfe('<qualquer/>'), /não é um XML de NF-e/);
});

test('sugestão loja → empresa pelo apelido', () => {
  const emp = ['UNIFULL', 'R SOUZA', 'TOP MIX'];
  assert.strictEqual(t.sugerirEmpresa('UNIFULL_MULTIMERCADO', emp), 'UNIFULL');
  assert.strictEqual(t.sugerirEmpresa('TOP_MIX_', emp), 'TOP MIX');
  assert.strictEqual(t.sugerirEmpresa('Shopee R SOUZA', emp), 'R SOUZA');
  assert.strictEqual(t.sugerirEmpresa('RICOPI_MULTIMERCADO', emp), null);
});
