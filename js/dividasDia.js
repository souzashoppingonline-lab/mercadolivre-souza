// Dívidas do dia — cálculo ÚNICO usado pelo botão "Enviar dívidas no WhatsApp"
// (pages/financeiro-boletos.html) e pela página de celular
// (pages/financeiro-dividas-hoje.html). Mesmo critério da página Boletos:
// "atrasado" = pendente com vencimento < hoje; compra-mãe de cartão
// (tipo='cartao') nunca entra — o cartão entra como FATURA (soma das parcelas
// pendentes do mesmo cartão + fatura_mes), igual a faturasMes() da página.
(function () {
  const DIAS_PROXIMOS = 3;
  const MAX_CHARS_WHATSAPP = 3500; // link wa.me com texto muito longo é cortado

  const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
  const ddmm = s => { const p = String(s || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : '—'; };
  const ddmmaaaa = s => { const p = String(s || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—'; };
  function somaDias(iso, n) {
    const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // hoje: 'YYYY-MM-DD' — o chamador passa o MESMO "hoje" que a página usa.
  function calcular({ boletos = [], parcelas = [], cartoes = [], hoje, diasProximos = DIAS_PROXIMOS }) {
    const limite = somaDias(hoje, diasProximos);
    const secoes = { atrasadas: [], hoje: [], proximos: [] };
    const secaoDe = (date, atrasada) => {
      if (atrasada || date < hoje) return 'atrasadas';
      if (date === hoje) return 'hoje';
      if (date <= limite) return 'proximos';
      return null;
    };

    boletos.forEach(b => {
      if (b.status === 'pago' || b.tipo === 'cartao' || !b.date) return;
      const date = String(b.date).slice(0, 10);
      const s = secaoDe(date, false); if (!s) return;
      secoes[s].push({
        id: b.id, date, valor: Number(b.value) || 0, fatura: false,
        empresa: String(b.empresa || '').trim() || 'Sem empresa',
        fornecedor: String(b.supplier || '').trim(), nome: String(b.name || '').trim(), tipo: b.tipo || 'boleto',
      });
    });

    const ativos = cartoes.filter(c => c.ativo !== false);
    ativos.forEach(c => {
      const porFatura = {};
      parcelas.filter(p => p.cartao_id === c.id && p.fatura_mes).forEach(p => { (porFatura[p.fatura_mes] = porFatura[p.fatura_mes] || []).push(p); });
      Object.entries(porFatura).forEach(([mes, ps]) => {
        ps.sort((a, b) => String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')));
        const pend = ps.filter(p => p.status !== 'pago');
        if (!pend.length) return;
        const date = String(ps[0].data_vencimento || `${mes}-${String(c.dia_vencimento || 10).padStart(2, '0')}`).slice(0, 10);
        const atrasada = pend.some(p => String(p.data_vencimento || '') < hoje);
        const s = secaoDe(date, atrasada); if (!s) return;
        secoes[s].push({
          id: `fatura-${c.id}-${mes}`, date, fatura: true, parcelas: pend.length,
          valor: pend.reduce((t, p) => t + (Number(p.valor) || 0), 0),
          empresa: '💳 Cartões', fornecedor: '', nome: `Fatura ${c.nome || 'cartão'}`, tipo: 'cartao',
        });
      });
    });

    Object.values(secoes).forEach(l => l.sort((a, b) => a.date.localeCompare(b.date) || b.valor - a.valor));
    const tot = l => l.reduce((t, i) => t + i.valor, 0);
    return {
      hoje, limite, diasProximos, secoes,
      totais: { atrasadas: tot(secoes.atrasadas), hoje: tot(secoes.hoje), proximos: tot(secoes.proximos) },
      total: tot(secoes.atrasadas) + tot(secoes.hoje) + tot(secoes.proximos),
      quantidade: secoes.atrasadas.length + secoes.hoje.length + secoes.proximos.length,
    };
  }

  const TITULOS = { atrasadas: '⚠️ *ATRASADAS*', hoje: '📅 *VENCEM HOJE*', proximos: '🔜 *PRÓXIMOS DIAS*' };

  function agruparPorEmpresa(itens) {
    const by = {};
    itens.forEach(i => { (by[i.empresa] = by[i.empresa] || []).push(i); });
    // Cartões por último; empresas em ordem alfabética.
    return Object.keys(by).sort((a, b) => (a === '💳 Cartões') - (b === '💳 Cartões') || a.localeCompare(b)).map(e => [e, by[e]]);
  }

  function linhaItem(i) {
    const desc = i.fatura ? `${i.nome} (${i.parcelas} parcela${i.parcelas > 1 ? 's' : ''})`
      : (i.fornecedor && i.nome && i.fornecedor.toLowerCase() !== i.nome.toLowerCase()
        ? `${i.fornecedor} — ${i.nome}` : (i.nome || i.fornecedor || '(sem descrição)'));
    return `• ${ddmm(i.date)} · ${desc} · ${i.valor > 0 ? `*${BRL(i.valor)}*` : '_valor a confirmar_'}`;
  }

  // maxPorSecao: com lista grande, mostra os N maiores valores de cada seção
  // e resume o resto em "+K outras (R$ X)" — o total da seção nunca muda.
  function montarTexto(r, nome, maxPorSecao) {
    const L = [`*Dívidas do dia — ${ddmmaaaa(r.hoje)}*`];
    if (nome) L.push(`Olá, ${nome}!`);
    if (!r.quantidade) { L.push('', `✅ Nenhuma dívida atrasada, vencendo hoje ou nos próximos ${r.diasProximos} dias.`); return L.join('\n'); }
    ['atrasadas', 'hoje', 'proximos'].forEach(k => {
      const itens = r.secoes[k];
      if (!itens.length) { if (k === 'hoje') L.push('', `${TITULOS.hoje} — nada ✅`); return; }
      const rotulo = k === 'proximos' ? `${TITULOS[k]} (até ${ddmm(r.limite)})` : TITULOS[k];
      L.push('', `${rotulo} — ${BRL(r.totais[k])} (${itens.length})`);
      let mostrar = itens;
      if (maxPorSecao && itens.length > maxPorSecao) {
        const top = new Set([...itens].sort((a, b) => b.valor - a.valor).slice(0, maxPorSecao));
        mostrar = itens.filter(i => top.has(i));
      }
      agruparPorEmpresa(mostrar).forEach(([emp, lista]) => {
        L.push(`_${emp}_`);
        lista.forEach(i => L.push(linhaItem(i)));
      });
      const resto = itens.filter(i => !mostrar.includes(i));
      if (resto.length) L.push(`+${resto.length} outra(s) · ${BRL(resto.reduce((t, i) => t + i.valor, 0))}`);
    });
    L.push('', `*Total até ${ddmm(r.limite)}: ${BRL(r.total)}*`);
    return L.join('\n');
  }

  function textoWhatsapp(r, nome) {
    let txt = montarTexto(r, nome, 0);
    for (let n = 15; txt.length > MAX_CHARS_WHATSAPP && n >= 3; n -= 3) txt = montarTexto(r, nome, n);
    return txt;
  }

  // Número BR sem DDI (10–11 dígitos) ganha o 55 na frente.
  function linkWhatsapp(numero, texto) {
    let n = String(numero || '').replace(/\D/g, '');
    if (n.length === 10 || n.length === 11) n = '55' + n;
    return `https://wa.me/${n}?text=${encodeURIComponent(texto)}`;
  }

  // Data LOCAL (Brasil). Não usar toISOString(): é UTC e depois das 21h já
  // devolve o dia seguinte (ver known-bugs.md, hojeISO da página Boletos).
  function hojeLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  window.DividasDia = { calcular, textoWhatsapp, linkWhatsapp, agruparPorEmpresa, hojeLocal, ddmm, BRL, DIAS_PROXIMOS };
})();
