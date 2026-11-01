// Leitor de extrato bancário OFX (PURO — testado em test/ofx.test.js).
// Aceita os dois formatos que os bancos brasileiros exportam:
//   • OFX 1.x (SGML): cabeçalho "OFXHEADER:100", tags sem fechamento (<TRNAMT>-10.00)
//   • OFX 2.x (XML): <?OFX ...?>, tags fechadas (<TRNAMT>-10.00</TRNAMT>)
// A leitura é por tag (`<TAG>valor` até o próximo `<`), que serve pros dois.
// Um arquivo pode ter mais de uma conta (vários <STMTRS>/<CCSTMTRS>).
// Usado por routes/extratoOfx.js. Ver .claude/extrato-ofx.md.

// Arquivo vem como Buffer: OFX 1.x de banco BR costuma ser Windows-1252
// ("CHARSET:1252"); sem isso os acentos viram "�". latin1 cobre os acentos do
// português (1252 só difere em símbolos raros como “ ” €).
function decodificar(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const cab = buf.slice(0, 600).toString('latin1');
  const utf8 = /ENCODING\s*[:=]\s*"?UTF-?8/i.test(cab) || /<\?xml[^>]*encoding="utf-?8"/i.test(cab);
  const latin = /CHARSET\s*[:=]\s*"?(1252|8859|ISO-8859-1|WINDOWS-1252)/i.test(cab);
  if (latin && !utf8) return buf.toString('latin1');
  const txt = buf.toString('utf8');
  // Sem declaração e com byte inválido em UTF-8 → era latin1.
  return !utf8 && txt.includes('�') ? buf.toString('latin1') : txt;
}

// Valor de uma tag dentro de um trecho: "<TAG>valor" até o próximo "<".
function tag(trecho, nome) {
  const m = trecho.match(new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i'));
  if (!m) return null;
  const v = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  return v === '' ? null : v;
}

// Blocos <NOME>…</NOME>; no SGML alguns bancos não fecham <STMTTRN> — aí o
// bloco vai até o próximo <NOME> ou o fim do pai.
function blocos(texto, nome, fimPai) {
  const out = [];
  const re = new RegExp(`<${nome}>`, 'gi');
  const idx = [];
  let m;
  while ((m = re.exec(texto))) idx.push(m.index);
  idx.forEach((ini, i) => {
    const prox = i + 1 < idx.length ? idx[i + 1] : texto.length;
    let trecho = texto.slice(ini, prox);
    const fecha = trecho.search(new RegExp(`</${nome}>`, 'i'));
    if (fecha >= 0) trecho = trecho.slice(0, fecha);
    else if (fimPai) { const f = trecho.search(new RegExp(`</${fimPai}>`, 'i')); if (f >= 0) trecho = trecho.slice(0, f); }
    out.push(trecho);
  });
  return out;
}

// "20261031120000[-3:BRT]" / "20261031" → "2026-10-31" (data do lançamento como o banco informou).
function dataOfx(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Valor: OFX manda "-1234.56", mas alguns bancos BR mandam "-1234,56" ou "-1.234,56".
function valorOfx(v) {
  let t = String(v || '').replace(/\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function lerConta(st, cartao) {
  const acc = (cartao ? blocos(st, 'CCACCTFROM')[0] : blocos(st, 'BANKACCTFROM')[0]) || st;
  const lista = blocos(st, 'BANKTRANLIST')[0] || st;
  const ledger = blocos(st, 'LEDGERBAL')[0] || '';
  const lancamentos = blocos(lista, 'STMTTRN', 'BANKTRANLIST').map((t, i) => ({
    fitid: tag(t, 'FITID'),
    tipo: (tag(t, 'TRNTYPE') || '').toUpperCase() || null,
    data: dataOfx(tag(t, 'DTPOSTED')),
    valor: valorOfx(tag(t, 'TRNAMT')),
    nome: tag(t, 'NAME'),
    memo: tag(t, 'MEMO'),
    checknum: tag(t, 'CHECKNUM'),
    ordem: i,
  })).filter((l) => l.data && l.valor != null);
  return {
    banco_id: cartao ? null : tag(acc, 'BANKID'),
    agencia: cartao ? null : tag(acc, 'BRANCHID'),
    conta: tag(acc, 'ACCTID'),
    tipo_conta: cartao ? 'CARTAO' : (tag(acc, 'ACCTTYPE') || 'CHECKING').toUpperCase(),
    moeda: tag(st, 'CURDEF') || 'BRL',
    dt_inicio: dataOfx(tag(lista, 'DTSTART')),
    dt_fim: dataOfx(tag(lista, 'DTEND')),
    saldo_final: ledger ? valorOfx(tag(ledger, 'BALAMT')) : null,
    saldo_final_em: ledger ? dataOfx(tag(ledger, 'DTASOF')) : null,
    lancamentos,
  };
}

// Devolve { banco_nome, contas:[{banco_id, agencia, conta, tipo_conta, dt_inicio, dt_fim,
// saldo_final, saldo_final_em, lancamentos:[{fitid, tipo, data, valor, nome, memo, checknum, ordem}]}] }.
// Lança erro claro se o arquivo não for OFX.
function lerOfx(buf) {
  const texto = decodificar(buf);
  if (!/<OFX>/i.test(texto)) throw new Error('Arquivo não parece um OFX (não achei a tag <OFX>). Exporte o extrato em formato OFX/Money no internet banking.');
  const fi = blocos(texto, 'FI')[0] || '';
  const banco_nome = tag(fi, 'ORG');
  const contas = [
    ...blocos(texto, 'STMTRS').map((st) => lerConta(st, false)),
    ...blocos(texto, 'CCSTMTRS').map((st) => lerConta(st, true)),
  ];
  if (!contas.length) throw new Error('O OFX não tem extrato de conta (<STMTRS>) — confira se exportou o extrato e não outro relatório.');
  return { banco_nome, contas };
}

module.exports = { lerOfx, decodificar, valorOfx, dataOfx };
