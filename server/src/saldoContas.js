// Saldo disponível de uma conta bancária a partir do saldo INFORMADO (Dívidas
// do Dia, janela de Pagar). Cálculo PURO (testado em test/saldoContas.test.js);
// carga em routes/saldoContas.js.
//
// disponível = último saldo informado − saídas + entradas lançadas no Fluxo de
// Caixa (cash_flow_entries) NAQUELA conta e criadas DEPOIS do informe
// (created_at, não `date`: o Pagar grava a saída com a data do vencimento,
// que pode ser de antes do informe). Pagamento desfeito apaga a saída → o
// saldo volta sozinho. Informe com mais de 24h fica "desatualizado".
const HORAS_DESATUALIZADO = 24;
const r2 = n => Math.round(n * 100) / 100;

function calcularSaldo(informado, movimentos = [], agora = new Date()) {
  if (!informado) return { informado: null, disponivel: null, saidas: 0, entradas: 0, desatualizado: false };
  const desde = new Date(informado.informado_em).getTime();
  let saidas = 0, entradas = 0, n = 0;
  movimentos.forEach(m => {
    if (!m || new Date(m.created_at).getTime() <= desde) return;
    const v = Number(m.value) || 0;
    if (m.type === 'income') entradas += v; else saidas += v;
    n++;
  });
  const horas = (new Date(agora).getTime() - desde) / 3600000;
  return {
    informado: r2(Number(informado.valor) || 0), informado_em: informado.informado_em, informado_por: informado.informado_por || null,
    saidas: r2(saidas), entradas: r2(entradas), movimentos: n,
    disponivel: r2((Number(informado.valor) || 0) - saidas + entradas),
    desatualizado: horas > HORAS_DESATUALIZADO,
  };
}

module.exports = { calcularSaldo, HORAS_DESATUALIZADO };
