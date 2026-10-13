// Dívidas recorrentes (boletos_recorrentes → boletos_mensais) — regra ÚNICA
// usada pelo botão "Gerar mês" e pela geração automática da página Boletos
// e da página Dívidas do Dia (celular). Ver .claude/modules.md.
(function () {
  const mesRef = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  // Mês atual + próximo (data local) — o próximo garante que "próximos dias"
  // na virada do mês já enxergue os recorrentes do mês seguinte.
  function mesesAutomaticos(agora = new Date()) {
    return [mesRef(agora), mesRef(new Date(agora.getFullYear(), agora.getMonth() + 1, 1))];
  }

  // Valor do cadastro se > 0; senão o último valor > 0 já lançado daquele
  // recorrente (os cadastros estão com R$0 e o valor varia mês a mês).
  // Flex nasce SEMPRE com 0 (pedido do usuário: o valor do Flex só é
  // conhecido depois) — aparece como "valor a confirmar".
  function valorPadrao(t, boletos) {
    if ((t.tipo || '') === 'flex') return 0;
    if (Number(t.valor_total) > 0) return Number(t.valor_total);
    const ult = boletos
      .filter(b => b.id_recorrente === t.id && Number(b.value) > 0)
      .sort((a, b) => String(b.mes_referencia || '').localeCompare(String(a.mes_referencia || '')) || String(b.date || '').localeCompare(String(a.date || '')))[0];
    return ult ? Number(ult.value) : 0;
  }

  // Linhas a criar no mês `mr` ('YYYY-MM'). Pula o recorrente que já tem
  // lançamento no mês — pelo id_recorrente ou pelo mesmo nome (lançamento manual).
  function planejar(recorrentes, boletos, mr) {
    const [y, m] = mr.split('-').map(Number);
    const ultimoDia = new Date(y, m, 0).getDate();
    return recorrentes.filter(t => t.ativo !== false).flatMap(t => {
      const jaExiste = boletos.some(b => (b.mes_referencia || '') === mr &&
        (b.id_recorrente === t.id || String(b.name || '').trim() === String(t.nome || '').trim()));
      if (jaExiste) return [];
      const dia = Math.min(Number(t.dia_vencimento) || 10, ultimoDia);
      return [{
        id_recorrente: t.id, name: t.nome, category: t.categoria || 'Geral', supplier: t.fornecedor || null,
        empresa: t.empresa || null, date: `${mr}-${String(dia).padStart(2, '0')}`,
        value: valorPadrao(t, boletos), status: 'pendente', mes_referencia: mr, tipo: t.tipo || 'boleto', is_origem: true,
      }];
    });
  }

  // Grava as linhas; conflito no índice único (id_recorrente, mes_referencia)
  // — outra aba gerou ao mesmo tempo — conta como "já existia", não como erro.
  async function inserir(rows, DB, boletos) {
    let criados = 0, pulados = 0;
    for (const row of rows) {
      const r = await DB.addFinanceiroRow('boletos_mensais', row);
      if (r && r.error) {
        if (/409|duplicate|unique/i.test(String(r.error))) { pulados++; continue; }
        return { criados, pulados, erro: r.error };
      }
      const saved = Array.isArray(r && r.rows) ? r.rows[0] : null;
      if (saved) { boletos.push(saved); criados++; }
    }
    return { criados, pulados, erro: null };
  }

  // Automático: roda UMA vez por mês — se o mês já tem qualquer lançamento
  // gerado de recorrente, não mexe (assim uma dívida apagada de propósito não
  // volta). Pra completar um mês já gerado, usar o botão "Gerar mês".
  async function gerarAutomatico({ recorrentes, boletos, DB, meses = mesesAutomaticos() }) {
    const out = { criados: 0, meses: [], erro: null };
    for (const mr of meses) {
      if (boletos.some(b => (b.mes_referencia || '') === mr && b.id_recorrente)) continue;
      const r = await inserir(planejar(recorrentes, boletos, mr), DB, boletos);
      out.criados += r.criados;
      if (r.criados) out.meses.push(mr);
      if (r.erro) { out.erro = r.erro; break; }
    }
    return out;
  }

  window.RecorrentesFin = { planejar, valorPadrao, inserir, gerarAutomatico, mesesAutomaticos };
})();
