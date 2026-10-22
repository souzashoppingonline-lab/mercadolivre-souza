// Leitura do código de um boleto (câmera ou digitado) — página Dívidas do Dia
// ("➕ Adicionar boleto / dívida"). PURO: navegador (window.BoletoCodigo) e
// Node (testes em server/test/boletoCodigo.test.js).
//
// Entende 3 coisas:
//  • Boleto BANCÁRIO — código de barras (44 dígitos, ITF) ou linha digitável
//    (47): banco, valor e VENCIMENTO (fator de vencimento FEBRABAN — base
//    07/10/1997, e o ciclo novo que recomeçou em 1000 em 22/02/2025).
//  • ARRECADAÇÃO (luz, água, telefone, imposto — começa com 8): 44 ou 48
//    dígitos; valor sim, vencimento NÃO vem no código.
//  • PIX copia-e-cola / QR (EMV "000201…"): valor (se houver), recebedor, CRC.
// Todo dígito verificador é conferido — leitura errada da câmera é descartada.
// procurar(): acha a dívida cadastrada (código salvo → valor+vencimento).
(function () {
  const so = s => String(s || '').replace(/\D/g, '');
  const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diffDias = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

  function mod10(num) {
    let soma = 0, peso = 2;
    for (let i = num.length - 1; i >= 0; i--) {
      let p = Number(num[i]) * peso;
      if (p > 9) p = Math.floor(p / 10) + (p % 10);
      soma += p; peso = peso === 2 ? 1 : 2;
    }
    return (10 - (soma % 10)) % 10;
  }
  function pesos11(num) {
    let soma = 0, peso = 2;
    for (let i = num.length - 1; i >= 0; i--) { soma += Number(num[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    return soma;
  }
  // Bancário (DV geral do código de barras): 0, 10 e 11 viram 1.
  function mod11Bancario(num) { const dv = 11 - (pesos11(num) % 11); return dv === 0 || dv === 10 || dv === 11 ? 1 : dv; }
  // Arrecadação: resto 0 ou 1 → 0.
  function mod11Arrecadacao(num) { const r = pesos11(num) % 11; return r === 0 || r === 1 ? 0 : 11 - r; }

  const BANCOS = { '001': 'Banco do Brasil', '033': 'Santander', '041': 'Banrisul', '077': 'Inter', '104': 'Caixa', '208': 'BTG Pactual', '212': 'Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6 Bank', '341': 'Itaú', '380': 'PicPay', '422': 'Safra', '655': 'Votorantim', '748': 'Sicredi', '756': 'Sicoob' };

  // Fator 0 = sem vencimento. Dois ciclos possíveis (antes/depois de
  // 22/02/2025): fica o mais perto de `hoje` (boleto é de agora, não de 2000).
  function vencimentoDoFator(fator, hoje) {
    if (!fator) return null;
    const antigo = somaDias('1997-10-07', fator);
    if (fator < 1000) return antigo;
    const novo = somaDias('2025-02-22', fator - 1000);
    return Math.abs(diffDias(novo, hoje)) <= Math.abs(diffDias(antigo, hoje)) ? novo : antigo;
  }

  function linhaBancaria(bc) {
    const c1 = bc.slice(0, 4) + bc.slice(19, 24), c2 = bc.slice(24, 34), c3 = bc.slice(34, 44);
    return `${c1}${mod10(c1)}${c2}${mod10(c2)}${c3}${mod10(c3)}${bc[4]}${bc.slice(5, 19)}`;
  }
  function linhaArrecadacao(bc) {
    const f = ['6', '7'].includes(bc[2]) ? mod10 : mod11Arrecadacao;
    return [0, 11, 22, 33].map(i => { const b = bc.slice(i, i + 11); return b + f(b); }).join('');
  }
  function formatarLinha(l) {
    if (l.length === 47) return `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`;
    if (l.length === 48) return [0, 12, 24, 36].map(i => `${l.slice(i, i + 11)}-${l[i + 11]}`).join(' ');
    return l;
  }

  function lerBancario(bc, hoje) {
    if (bc[3] !== '9') return { ok: false, erro: 'moeda inválida no código' };
    if (mod11Bancario(bc.slice(0, 4) + bc.slice(5)) !== Number(bc[4])) return { ok: false, erro: 'dígito verificador não confere' };
    const banco = bc.slice(0, 3), linha = linhaBancaria(bc);
    return {
      ok: true, tipo: 'bancario', codigo: bc, linha, linhaFormatada: formatarLinha(linha),
      banco, bancoNome: BANCOS[banco] || `Banco ${banco}`,
      valor: Number(bc.slice(9, 19)) / 100, vencimento: vencimentoDoFator(Number(bc.slice(5, 9)), hoje),
    };
  }
  function lerArrecadacao(bc) {
    const id = bc[2];
    if (!['6', '7', '8', '9'].includes(id)) return { ok: false, erro: 'identificador de valor inválido' };
    const f = ['6', '7'].includes(id) ? mod10 : mod11Arrecadacao;
    if (f(bc.slice(0, 3) + bc.slice(4)) !== Number(bc[3])) return { ok: false, erro: 'dígito verificador não confere' };
    const SEG = { 1: 'Prefeitura', 2: 'Saneamento', 3: 'Energia/gás', 4: 'Telecomunicações', 5: 'Órgão público', 6: 'Carnê/convênio', 7: 'Multa de trânsito', 9: 'Uso exclusivo do banco' };
    const linha = linhaArrecadacao(bc);
    return {
      ok: true, tipo: 'arrecadacao', codigo: bc, linha, linhaFormatada: formatarLinha(linha),
      segmento: SEG[bc[1]] || 'Arrecadação', valor: ['6', '8'].includes(id) ? Number(bc.slice(4, 15)) / 100 : 0, vencimento: null,
    };
  }

  // CRC16/CCITT-FALSE do padrão PIX (BR Code).
  function crc16(s) {
    let crc = 0xFFFF;
    for (let i = 0; i < s.length; i++) {
      crc ^= s.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  function tlv(s) {
    const out = {};
    for (let i = 0; i + 4 <= s.length;) {
      const id = s.slice(i, i + 2), n = Number(s.slice(i + 2, i + 4));
      if (!Number.isFinite(n)) break;
      out[id] = s.slice(i + 4, i + 4 + n); i += 4 + n;
    }
    return out;
  }
  function lerPix(txt) {
    const s = String(txt).trim();
    const i63 = s.lastIndexOf('6304');
    if (i63 < 0 || s.length !== i63 + 8 || crc16(s.slice(0, i63 + 4)) !== s.slice(i63 + 4).toUpperCase()) return { ok: false, erro: 'PIX com CRC inválido' };
    const t = tlv(s), conta = tlv(t['26'] || '');
    if (!/br\.gov\.bcb\.pix/i.test(conta['00'] || '')) return { ok: false, erro: 'QR não é PIX' };
    return { ok: true, tipo: 'pix', codigo: s, linha: s, linhaFormatada: s, valor: t['54'] ? Number(t['54']) : 0, vencimento: null,
      recebedor: (t['59'] || '').trim(), cidade: (t['60'] || '').trim(), chave: conta['01'] || '' };
  }

  // Entrada: o que a câmera leu ou o que foi digitado/colado.
  function ler(entrada, hoje) {
    const txt = String(entrada || '').trim();
    if (/^000201/.test(txt)) return lerPix(txt);
    const d = so(txt);
    let bc;
    if (d.length === 44) bc = d;
    else if (d.length === 47 && d[0] !== '8') {
      for (const [ini, fim, dv] of [[0, 9, 9], [10, 20, 20], [21, 31, 31]]) if (mod10(d.slice(ini, fim)) !== Number(d[dv])) return { ok: false, erro: 'linha digitável com dígito errado — confira os números' };
      bc = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
    } else if (d.length === 48 && d[0] === '8') {
      const f = ['6', '7'].includes(d[2]) ? mod10 : mod11Arrecadacao;
      for (const i of [0, 12, 24, 36]) if (f(d.slice(i, i + 11)) !== Number(d[i + 11])) return { ok: false, erro: 'linha digitável com dígito errado — confira os números' };
      bc = d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
    } else return { ok: false, erro: d.length ? `código com ${d.length} dígitos — boleto tem 44, 47 ou 48` : 'nenhum número encontrado' };
    return bc[0] === '8' ? lerArrecadacao(bc) : lerBancario(bc, hoje);
  }

  // Procura a dívida: 1) código já salvo (exato); 2) mesmo valor (centavo) com
  // vencimento até ±10 dias (ou qualquer data, se o código não tem vencimento);
  // 3) dívida "valor a confirmar" (R$0) vencendo até ±3 dias. Compra-mãe de
  // cartão nunca entra. `jaPagas` = mesma coisa já paga (evita pagar 2×).
  function procurar(boletos, leitura) {
    const base = (boletos || []).filter(b => b.tipo !== 'cartao' && b.date);
    const centavos = v => Math.round((Number(v) || 0) * 100);
    const alvo = centavos(leitura.valor), venc = leitura.vencimento;
    const dias = b => (venc ? Math.abs(diffDias(String(b.date).slice(0, 10), venc)) : null);
    const porCodigo = base.filter(b => b.codigo_barras && b.codigo_barras === leitura.codigo);
    const parecido = b => alvo > 0 && centavos(b.value) === alvo && (dias(b) === null || dias(b) <= 10);
    const ordem = (a, b) => (a.dias ?? 0) - (b.dias ?? 0) || String(a.boleto.date).localeCompare(String(b.boleto.date));
    const pendente = b => b.status !== 'pago';
    let opcoes = porCodigo.filter(pendente).map(b => ({ boleto: b, motivo: 'codigo', dias: dias(b) }));
    if (!opcoes.length) {
      opcoes = base.filter(b => pendente(b) && !b.codigo_barras && parecido(b)).map(b => ({ boleto: b, motivo: 'valor', dias: dias(b) })).sort(ordem);
      if (venc) opcoes.push(...base.filter(b => pendente(b) && !b.codigo_barras && centavos(b.value) === 0 && dias(b) <= 3)
        .map(b => ({ boleto: b, motivo: 'valor_a_confirmar', dias: dias(b) })).sort(ordem));
    }
    const jaPagas = base.filter(b => !pendente(b) && (b.codigo_barras ? b.codigo_barras === leitura.codigo : parecido(b) && dias(b) !== null && dias(b) <= 3));
    return { opcoes, jaPagas };
  }

  const API = { ler, procurar, formatarLinha, linhaBancaria, linhaArrecadacao, mod10, mod11Bancario, mod11Arrecadacao, crc16, vencimentoDoFator, BANCOS };
  if (typeof window !== 'undefined') window.BoletoCodigo = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
