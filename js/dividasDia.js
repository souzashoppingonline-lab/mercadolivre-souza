// Dívidas do dia — cálculo ÚNICO usado pelo botão "Enviar dívidas no WhatsApp"
// (pages/financeiro-boletos.html), pela página de celular
// (pages/financeiro-dividas-hoje.html) e pelo push das 07:00 (worker.js). Mesmo critério da página Boletos:
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

  // Todos os itens (pagos E pendentes) — boletos + faturas de cartão.
  // hoje: 'YYYY-MM-DD' — o chamador passa o MESMO "hoje" que a página usa.
  // Fatura: data = 1º vencimento; pendente → valor = parcelas pendentes,
  // atrasada se alguma pendente venceu; toda paga → valor = total, pago=true.
  function montarItens({ boletos = [], parcelas = [], cartoes = [], hoje }) {
    const itens = [];
    boletos.forEach(b => {
      if (b.tipo === 'cartao' || !b.date) return;
      const date = String(b.date).slice(0, 10), pago = b.status === 'pago';
      itens.push({
        id: b.id, ref: b, date, valor: Number(b.value) || 0, fatura: false, pago, atrasada: !pago && date < hoje,
        empresa: String(b.empresa || '').trim() || 'Sem empresa',
        fornecedor: String(b.supplier || '').trim(), nome: String(b.name || '').trim(), tipo: b.tipo || 'boleto',
      });
    });
    cartoes.filter(c => c.ativo !== false).forEach(c => {
      const porFatura = {};
      parcelas.filter(p => p.cartao_id === c.id && p.fatura_mes).forEach(p => { (porFatura[p.fatura_mes] = porFatura[p.fatura_mes] || []).push(p); });
      Object.entries(porFatura).forEach(([mes, ps]) => {
        ps.sort((a, b) => String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')));
        const pend = ps.filter(p => p.status !== 'pago'), pago = !pend.length;
        const date = String(ps[0].data_vencimento || `${mes}-${String(c.dia_vencimento || 10).padStart(2, '0')}`).slice(0, 10);
        const base = pago ? ps : pend;
        itens.push({
          id: `fatura-${c.id}-${mes}`, cartao: c, faturaMes: mes, pendentes: pend, date, fatura: true, parcelas: base.length, pago,
          atrasada: pend.some(p => String(p.data_vencimento || '') < hoje),
          valor: base.reduce((t, p) => t + (Number(p.valor) || 0), 0),
          empresa: '💳 Cartões', fornecedor: '', nome: `Fatura ${c.nome || 'cartão'}`, tipo: 'cartao',
        });
      });
    });
    return itens;
  }

  // Só o que falta pagar, em 3 seções (atrasadas / hoje / próximos dias) —
  // base da mensagem do WhatsApp.
  function calcular({ boletos = [], parcelas = [], cartoes = [], hoje, diasProximos = DIAS_PROXIMOS }) {
    const limite = somaDias(hoje, diasProximos);
    const secoes = { atrasadas: [], hoje: [], proximos: [] };
    montarItens({ boletos, parcelas, cartoes, hoje }).forEach(i => {
      if (i.pago) return;
      const s = (i.atrasada || i.date < hoje) ? 'atrasadas' : i.date === hoje ? 'hoje' : i.date <= limite ? 'proximos' : null;
      if (s) secoes[s].push(i);
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

  // TODAS as dívidas (pagas e a pagar) com vencimento entre `de` e `ate`.
  function listarPeriodo({ boletos = [], parcelas = [], cartoes = [], hoje, de, ate }) {
    return montarItens({ boletos, parcelas, cartoes, hoje })
      .filter(i => i.date >= de && i.date <= ate)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.pago - b.pago) || b.valor - a.valor);
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

  // ── Mensagem da página do celular: SÓ a lista do botão selecionado ─────
  // (Hoje / Amanhã / Próx. 3 dias / Atrasadas), TODAS as dívidas da lista com
  // o status de cada uma, 1 bloco por dívida separado por linha (pedido do
  // usuário: "separação por linha de cada dívida com data e bastante emoji").
  const EMOJI_TIPO = { boleto: '🧾', manual: '🏛️', cartao: '💳', fatura_ml: '🛒', flex: '🛵', pessoal: '👤', folha_pagamento: '👥', custo_fixo: '📌', custo_variavel: '📈' };
  const NOME_TIPO = { boleto: 'Boleto', manual: 'Imposto', cartao: 'Cartão', fatura_ml: 'Fatura ML', flex: 'Flex', pessoal: 'Pessoal', folha_pagamento: 'Folha', custo_fixo: 'Custo fixo', custo_variavel: 'Custo variável' };
  const LINHA = '━━━━━━━━━━━━━━━';
  const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const diaSemana = iso => DIAS_SEMANA[new Date(String(iso).slice(0, 10) + 'T12:00:00').getDay()];

  function statusDe(i) {
    if (i.pago) return '✅ *PAGO*';
    if (i.atrasada) return '🚨 *ATRASADA*';
    return '🕗 *A PAGAR*';
  }

  function blocoDivida(i) {
    const L = [statusDe(i)];
    L.push(`📆 ${diaSemana(i.date)}, ${ddmm(i.date)}${i.fatura || i.empresa === 'Sem empresa' ? '' : ` · 🏢 ${i.empresa}`}`);
    if (i.fatura) {
      L.push(`💳 ${i.nome} (${i.parcelas} parcela${i.parcelas > 1 ? 's' : ''})`);
    } else {
      L.push(`${EMOJI_TIPO[i.tipo] || '🧾'} ${i.nome || i.fornecedor || '(sem descrição)'}`);
      if (i.fornecedor && i.nome && i.fornecedor.toLowerCase() !== i.nome.toLowerCase()) L.push(`🏭 ${i.fornecedor}`);
      L.push(`🏷️ ${NOME_TIPO[i.tipo] || i.tipo}`);
    }
    L.push(i.valor > 0 ? `💰 *${BRL(i.valor)}*` : '❓ _valor a confirmar_');
    return L.join('\n');
  }

  // titulo: ex. '📅 *DÍVIDAS DE HOJE*'; periodo: ex. 'Ter, 13/10/2026'.
  function textoWhatsappLista({ titulo, periodo, itens, nome }) {
    const soma = l => l.reduce((t, i) => t + i.valor, 0);
    const pagos = itens.filter(i => i.pago), atrasadas = itens.filter(i => !i.pago && i.atrasada);
    const aPagar = itens.filter(i => !i.pago && !i.atrasada);
    const cab = [`💸 ${titulo} 💸`, `🗓️ ${periodo}`];
    if (nome) cab.push(`👋 Olá, ${nome}!`);
    const resumo = ['', '📊 *RESUMO*',
      `🧾 Total: *${BRL(soma(itens))}* (${itens.length} conta${itens.length === 1 ? '' : 's'})`,
      `✅ Pago: ${BRL(soma(pagos))} (${pagos.length})`,
      `🕗 A pagar: ${BRL(soma(aPagar))} (${aPagar.length})`];
    if (atrasadas.length) resumo.push(`🚨 Atrasadas: ${BRL(soma(atrasadas))} (${atrasadas.length})`);
    resumo.push(aPagar.length + atrasadas.length ? `\n👉 Falta pagar: *${BRL(soma(aPagar) + soma(atrasadas))}*` : '\n🎉 Tudo pago! 🎉');
    if (!itens.length) return [...cab, '', '✅ Nenhuma dívida neste período! 🎉'].join('\n');
    // Lista longa (link wa.me corta texto grande): mostra as primeiras N e
    // resume o resto — o RESUMO sempre soma todas.
    for (let n = itens.length; n >= 1; n = n > 10 ? n - 5 : n - 1) {
      const mostrar = itens.slice(0, n), resto = itens.slice(n);
      const corpo = ['', LINHA, ...mostrar.map(i => blocoDivida(i) + '\n' + LINHA)];
      if (resto.length) corpo.push(`➕ mais ${resto.length} conta(s) · ${BRL(soma(resto))} — veja na página`);
      const txt = [...cab, ...corpo, ...resumo].join('\n');
      if (txt.length <= MAX_CHARS_WHATSAPP || n === 1) return txt;
    }
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

  // Notificação push das 07:00 (job checkDividasPush do worker.js): só o que
  // vence HOJE + atrasadas, a partir do MESMO calcular() da página. null =
  // nada a pagar → o job não manda notificação nenhuma.
  function textoNotificacao(r) {
    const h = r.secoes.hoje, a = r.secoes.atrasadas;
    if (!h.length && !a.length) return null;
    const nomes = l => {
      const n = l.map(i => i.nome || i.fornecedor || 'conta');
      return n.length <= 2 ? n.join(' e ') : `${n.slice(0, 2).join(', ')} e +${n.length - 2}`;
    };
    const atr = a.length ? `⚠️ ${a.length} atrasada${a.length > 1 ? 's' : ''} (${BRL(r.totais.atrasadas)})` : '';
    if (h.length) {
      return {
        title: `💸 ${h.length} conta${h.length > 1 ? 's vencem' : ' vence'} hoje — ${BRL(r.totais.hoje)}`,
        body: [nomes(h), atr].filter(Boolean).join('\n'),
      };
    }
    return { title: `⚠️ ${a.length} conta${a.length > 1 ? 's' : ''} atrasada${a.length > 1 ? 's' : ''} — ${BRL(r.totais.atrasadas)}`, body: nomes(a) };
  }

  const API = { calcular, listarPeriodo, somaDias, textoWhatsapp, textoWhatsappLista, textoNotificacao, linkWhatsapp, agruparPorEmpresa, hojeLocal, ddmm, BRL, DIAS_PROXIMOS };
  // Navegador (páginas) e Node (worker.js reusa o cálculo pro push das 07:00).
  if (typeof window !== 'undefined') window.DividasDia = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
