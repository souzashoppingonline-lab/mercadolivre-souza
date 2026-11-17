// Análise Tributária (v186) — regras PURAS (sem banco/rede), testadas em
// test/tributario.test.js. Rotas em routes/tributario.js; página
// pages/financeiro-analise-tributaria.html. Regras e fontes: .claude/analise-tributaria.md.
// Tudo aqui é ESTIMATIVA com parâmetros visíveis — não substitui o contador.

// ── Simples Nacional — Anexo I (comércio) ────────────────────────────────────
const SIMPLES_ANEXO_I = [
  { faixa: 1, ate: 180000, nominal: 4.0, deduzir: 0 },
  { faixa: 2, ate: 360000, nominal: 7.3, deduzir: 5940 },
  { faixa: 3, ate: 720000, nominal: 9.5, deduzir: 13860 },
  { faixa: 4, ate: 1800000, nominal: 10.7, deduzir: 22500 },
  { faixa: 5, ate: 3600000, nominal: 14.3, deduzir: 87300 },
  { faixa: 6, ate: 4800000, nominal: 19.0, deduzir: 378000 },
];
const SUBLIMITE_SP = 3600000;
const TETO_SIMPLES = 4800000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Faixa e alíquota efetiva pela receita bruta dos últimos 12 meses (RBT12).
// Efetiva = (RBT12 × nominal − parcela a deduzir) ÷ RBT12. Acima do teto: fora do Simples.
function faixaSimples(rbt12) {
  const r = Math.max(0, Number(rbt12) || 0);
  if (r > TETO_SIMPLES) return { faixa: null, acima_teto: true, rbt12: r2(r), nominal: null, efetiva: null, deduzir: null, limite: TETO_SIMPLES, falta_proxima: null };
  const f = SIMPLES_ANEXO_I.find((x) => r <= x.ate);
  const efetiva = r > 0 ? ((r * f.nominal) / 100 - f.deduzir) / r * 100 : f.nominal;
  return {
    faixa: f.faixa, acima_teto: false, rbt12: r2(r), nominal: f.nominal, deduzir: f.deduzir,
    efetiva: Math.round(Math.max(efetiva, 0) * 100) / 100, limite: f.ate,
    falta_proxima: f.faixa < 6 ? r2(f.ate - r) : r2(TETO_SIMPLES - r),
    acima_sublimite: r > SUBLIMITE_SP,
  };
}

// ── Estados ──────────────────────────────────────────────────────────────────
const UFS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const NOME_PARA_UF = Object.fromEntries(Object.entries(UFS).map(([uf, n]) => [semAcento(n), uf]));
// "São Paulo" / "sao paulo" / "SP" / "BR-SP" → "SP"; desconhecido → null.
function ufDe(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const sig = t.toUpperCase().replace(/^BR-/, '');
  if (UFS[sig]) return sig;
  return NOME_PARA_UF[semAcento(t)] || null;
}
// Alíquota interestadual de ICMS saindo de SP: 12% p/ Sul e Sudeste (exceto ES), 7% p/ N/NE/CO e ES. SP→SP = interna (null).
const SUL_SUDESTE_12 = new Set(['PR', 'SC', 'RS', 'MG', 'RJ']);
function aliquotaInterestadualSP(uf) {
  if (!uf || uf === 'SP') return null;
  return SUL_SUDESTE_12.has(uf) ? 12 : 7;
}

// ── Leitura da NF-e (XML) ────────────────────────────────────────────────────
// Leitor mínimo por expressão regular — a NF-e tem layout fixo e o servidor não
// tem lib de XML. Só os campos que a análise usa. Tags sem prefixo de namespace
// (padrão da NF-e). `<ICMS>` ≠ `<ICMSTot>`, `<vICMS>` ≠ `<vICMSST>` (casamos o `>`).
const bloco = (xml, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml || ''); return m ? m[1] : ''; };
const blocos = (xml, tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const valor = (xml, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml || ''); return m ? m[1].trim() : ''; };
const numero = (xml, tag) => { const v = parseFloat(valor(xml, tag)); return Number.isFinite(v) ? v : 0; };

function parseNfe(xml) {
  const inf = /<infNFe\s[^>]*Id="NFe(\d{44})"/.exec(xml || '');
  if (!inf) throw new Error('não é um XML de NF-e (sem infNFe/Id)');
  const ide = bloco(xml, 'ide'), emit = bloco(xml, 'emit'), dest = bloco(xml, 'dest'), tot = bloco(xml, 'ICMSTot');
  const itens = blocos(xml, 'det').map((det) => {
    const prod = bloco(det, 'prod'), imp = bloco(det, 'imposto');
    const icms = bloco(imp, 'ICMS');
    const grupo = (/<(ICMS[A-Z0-9]+)>/.exec(icms) || [])[1] || '';
    const g = bloco(icms, grupo);
    const pis = bloco(imp, 'PIS');
    return {
      codigo: valor(prod, 'cProd'), descricao: valor(prod, 'xProd'), ncm: valor(prod, 'NCM'), cfop: valor(prod, 'CFOP'),
      v_prod: numero(prod, 'vProd'), v_desc: numero(prod, 'vDesc'),
      icms: {
        grupo, cst: valor(g, 'CST'), csosn: valor(g, 'CSOSN'), orig: valor(g, 'orig'),
        v_icms: numero(g, 'vICMS'), p_icms: numero(g, 'pICMS'),
        v_icms_st: numero(g, 'vICMSST'), v_bc_st: numero(g, 'vBCST'), v_bc_st_ret: numero(g, 'vBCSTRet'),
        p_cred_sn: numero(g, 'pCredSN'), v_cred_sn: numero(g, 'vCredICMSSN'),
      },
      pis_cst: valor(pis, 'CST'),
    };
  });
  return {
    chave: inf[1], numero: valor(ide, 'nNF'), emissao: (valor(ide, 'dhEmi') || valor(ide, 'dEmi')).slice(0, 10),
    emitente: { cnpj: valor(emit, 'CNPJ') || valor(emit, 'CPF'), nome: valor(emit, 'xNome'), uf: valor(bloco(emit, 'enderEmit'), 'UF'), crt: valor(emit, 'CRT') },
    destinatario: { cnpj: valor(dest, 'CNPJ') || valor(dest, 'CPF'), uf: valor(bloco(dest, 'enderDest'), 'UF') },
    total: { v_nf: numero(tot, 'vNF'), v_prod: numero(tot, 'vProd'), v_icms: numero(tot, 'vICMS'), v_st: numero(tot, 'vST'), v_desc: numero(tot, 'vDesc') },
    itens,
  };
}

// ── Créditos ─────────────────────────────────────────────────────────────────
const REGIME_CRT = { 1: 'Simples Nacional', 2: 'Simples (excesso de sublimite)', 3: 'Regime normal (Real ou Presumido)', 4: 'MEI' };
const CST_ST = new Set(['10', '30', '60', '70']);
const CSOSN_ST = new Set(['201', '202', '203', '500']);
const PIS_SEM_CREDITO = new Set(['04', '05', '06', '07', '08', '09']);   // monofásico, alíquota zero, ST, isento, sem incidência, suspensão
const PIS_COFINS_NC = 9.25;

function itemTemST(it) {
  const c = it.icms;
  return CST_ST.has(c.cst) || CSOSN_ST.has(c.csosn) || c.v_icms_st > 0 || c.v_bc_st > 0 || c.v_bc_st_ret > 0;
}
// Crédito de ICMS que a SUA empresa teria no regime normal com esta nota.
// Emitente regime normal (CRT 2/3): ICMS destacado do item. Simples/MEI (CRT 1/4): vCredICMSSN.
function creditosNota(nota) {
  const crt = String(nota.emitente.crt || '');
  const normal = crt === '2' || crt === '3';
  let credito_icms = 0, icms_destacado = 0, v_st = 0, itens_st = 0, base_pc = 0, valor_itens = 0;
  for (const it of nota.itens) {
    const st = itemTemST(it);
    const liquido = Math.max(0, it.v_prod - it.v_desc);
    valor_itens += liquido;
    icms_destacado += it.icms.v_icms;
    v_st += it.icms.v_icms_st;
    if (st) itens_st++;
    credito_icms += normal ? it.icms.v_icms : it.icms.v_cred_sn;
    if (!PIS_SEM_CREDITO.has(it.pis_cst)) base_pc += liquido;
  }
  return {
    crt, regime: REGIME_CRT[crt] || 'Não informado', regime_normal: normal,
    itens: nota.itens.length, itens_st, valor_itens: r2(valor_itens),
    icms_destacado: r2(icms_destacado), credito_icms: r2(credito_icms), v_st: r2(v_st || nota.total.v_st),
    base_pis_cofins: r2(base_pc), credito_pis_cofins: r2(base_pc * PIS_COFINS_NC / 100),
  };
}

// Agrega as notas (já com creditosNota) por fornecedor (CNPJ do emitente).
function resumoFornecedores(notas) {
  const por = new Map();
  for (const n of notas) {
    const k = n.emitente.cnpj || n.emitente.nome;
    const c = n.creditos;
    const f = por.get(k) || { cnpj: n.emitente.cnpj, nome: n.emitente.nome, uf: n.emitente.uf, crt: c.crt, regime: c.regime,
      notas: 0, total_compras: 0, icms_destacado: 0, credito_icms: 0, v_st: 0, itens: 0, itens_st: 0, credito_pis_cofins: 0, ultima: '' };
    f.notas++; f.total_compras += n.total.v_nf; f.icms_destacado += c.icms_destacado; f.credito_icms += c.credito_icms;
    f.v_st += c.v_st; f.itens += c.itens; f.itens_st += c.itens_st; f.credito_pis_cofins += c.credito_pis_cofins;
    if ((n.emissao || '') > f.ultima) f.ultima = n.emissao || '';
    por.set(k, f);
  }
  return [...por.values()].map((f) => {
    const pct = f.total_compras > 0 ? (f.credito_icms / f.total_compras) * 100 : 0;
    return { ...f, total_compras: r2(f.total_compras), icms_destacado: r2(f.icms_destacado), credito_icms: r2(f.credito_icms),
      v_st: r2(f.v_st), credito_pis_cofins: r2(f.credito_pis_cofins),
      pct_credito_icms: Math.round(pct * 100) / 100, pct_itens_st: f.itens ? Math.round((f.itens_st / f.itens) * 100) : 0,
      semaforo: pct >= 7 ? 'verde' : pct > 0 ? 'amarelo' : 'vermelho' };
  }).sort((a, b) => b.total_compras - a.total_compras);
}

// Sugestão automática loja → empresa: nome da empresa contido no apelido da loja
// (sem acento, "_" vira espaço). Empresa de nome mais longo primeiro ("R SOUZA" antes de "SOUZA").
function sugerirEmpresa(nickname, empresas) {
  const n = ' ' + semAcento(nickname).replace(/_+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const ord = [...empresas].sort((a, b) => b.length - a.length);
  return ord.find((e) => n.includes(' ' + semAcento(e).replace(/_+/g, ' ') + ' ') || n.includes(semAcento(e).replace(/_+/g, ' '))) || null;
}

module.exports = {
  SIMPLES_ANEXO_I, SUBLIMITE_SP, TETO_SIMPLES, faixaSimples, UFS, ufDe, aliquotaInterestadualSP,
  parseNfe, creditosNota, resumoFornecedores, itemTemST, REGIME_CRT, PIS_COFINS_NC, sugerirEmpresa,
};
