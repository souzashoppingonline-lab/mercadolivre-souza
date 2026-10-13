// Pagamento de dívidas — regra ÚNICA usada pela página Boletos
// (financeiro-boletos.html) e pela página do celular (financeiro-dividas-hoje.html).
// Boleto pago → status 'pago' + saída em cash_flow_entries (vínculo boleto_id,
// com conta bancária/empresa/NF); desfazer → volta a 'pendente' e apaga a saída.
// Fatura de cartão → quita as parcelas pendentes + fatura_pagamentos + saída
// no fluxo de caixa. Ver .claude/modules.md (Boletos / Dívidas do Dia).
(function () {
  const nfDe = b => b.numero_nf || b.nf || b.nota_fiscal || '';

  // Contas ativas; se a dívida tem empresa, só as contas ligadas a ela
  // (conta_empresas) — se nenhuma estiver ligada, mostra todas.
  function contasDaEmpresa(contas, contaEmpresas, empresa) {
    let lista = (contas || []).filter(c => c.ativa !== false);
    const emp = String(empresa || '').trim();
    if (emp) {
      const ids = new Set((contaEmpresas || []).filter(ce => String(ce.empresa_nome || '').trim() === emp).map(ce => ce.conta_id));
      const f = lista.filter(c => ids.has(c.id)); if (f.length) lista = f;
    }
    return lista;
  }

  // Regra do Readdy: idempotente — apaga a saída existente daquele boleto
  // antes de inserir. Devolve null ou a mensagem de erro (não lança).
  async function syncFCPagamento(DB, boleto, pago, contaId, hoje) {
    try {
      const r = await DB.getFinanceiroDados('cash_flow_entries', 200, '', 'boleto_id=eq.' + encodeURIComponent(boleto.id));
      const existentes = (r && !r.error && Array.isArray(r.rows)) ? r.rows : [];
      for (const e of existentes) { await DB.deleteFinanceiroRow('cash_flow_entries', e.id); }
      if (pago) {
        const row = {
          type: 'expense', date: (boleto.date || '').slice(0, 10) || hoje, value: +boleto.value || 0,
          reason: (boleto.name || 'Boleto') + (boleto.supplier ? (' — ' + boleto.supplier) : ''),
          category: boleto.category || null, store_id: boleto.store_id || null, boleto_id: boleto.id,
        };
        if (boleto.empresa) row.empresa = boleto.empresa;
        if (contaId) row.conta_bancaria_id = contaId;
        const nf = nfDe(boleto); if (nf) row.nota_fiscal = nf;
        const ins = await DB.addFinanceiroRow('cash_flow_entries', row);
        if (ins && ins.error) return ins.error;
      }
      return null;
    } catch (e) { return e.message || String(e); }
  }

  // extra: campos a gravar junto (ex.: { value } quando a dívida estava sem valor).
  async function pagarBoleto(DB, boleto, contaId, hoje, extra = {}) {
    const patch = { status: 'pago', ...extra };
    const r = await DB.updateFinanceiroRow('boletos_mensais', boleto.id, patch);
    if (r && r.error) return { erro: r.error };
    const pagoRow = { ...boleto, ...patch };
    const erroFC = await syncFCPagamento(DB, pagoRow, true, contaId, hoje);
    return { boleto: pagoRow, erroFC };
  }

  async function desfazerPagamentoBoleto(DB, boleto, hoje) {
    const r = await DB.updateFinanceiroRow('boletos_mensais', boleto.id, { status: 'pendente' });
    if (r && r.error) return { erro: r.error };
    const erroFC = await syncFCPagamento(DB, boleto, false, null, hoje);
    return { boleto: { ...boleto, status: 'pendente' }, erroFC };
  }

  // pendentes: parcelas_cartao ainda não pagas daquela fatura (cartao + fatura_mes).
  async function pagarFatura(DB, { cartao, faturaMes, pendentes, hoje }) {
    const tot = pendentes.reduce((s, p) => s + (+p.valor || 0), 0);
    const pagas = [];
    for (const p of pendentes) {
      const r = await DB.updateFinanceiroRow('parcelas_cartao', p.id, { status: 'pago' });
      if (r && r.error) return { erro: r.error, pagas };
      pagas.push(p.id);
    }
    await DB.addFinanceiroRow('fatura_pagamentos', { cartao_id: cartao.id, fatura_mes: faturaMes, data_pagamento: hoje, valor_pago: +tot.toFixed(2), parcelas_count: pendentes.length });
    await DB.addFinanceiroRow('cash_flow_entries', { type: 'expense', date: hoje, value: +tot.toFixed(2), reason: `Fatura ${cartao.nome || 'cartão'} ${faturaMes}`, category: 'Cartão de Crédito' });
    return { pagas, total: tot };
  }

  window.PagamentosFin = { contasDaEmpresa, syncFCPagamento, pagarBoleto, desfazerPagamentoBoleto, pagarFatura, nfDe };
})();
