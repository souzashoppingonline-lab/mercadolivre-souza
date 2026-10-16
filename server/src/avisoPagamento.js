// Aviso no Telegram quando uma dívida é paga (ou o pagamento é desfeito) pela
// página Dívidas do Dia — pro dono saber na hora o que a responsável pagou.
// Texto PURO (testado em test/avisoPagamento.test.js); envio na rota
// POST /api/financeiro/aviso-pagamento (routes/financeiro.js) via
// tgNotifyForce('tg_pagamentos') — cada pagamento chega, sem throttle nem
// janela de silêncio; desliga com app_config tg_pagamentos='false'.
const BRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const esc = s => String(s == null ? '' : s).slice(0, 120).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ddmm = s => { const p = String(s || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : ''; };

// b: { nome, valor, conta, empresa, vencimento (YYYY-MM-DD), atrasada,
//      fatura, parcelas, desfeito, faltam_hoje: { n, valor } }
function textoAvisoPagamento(b = {}) {
  const nome = esc(b.nome || 'Dívida');
  const valor = Number(b.valor) || 0;
  if (b.desfeito) {
    return `↩️ <b>Pagamento desfeito</b> — ${nome}\n💰 ${BRL(valor)} voltou pra <b>a pagar</b>` +
      (b.empresa ? `\n🏢 ${esc(b.empresa)}` : '') + '\n📱 Dívidas do Dia';
  }
  const L = [b.fatura
    ? `💳 <b>Fatura paga</b> — ${nome}${b.parcelas ? ` (${Number(b.parcelas)} parcela${Number(b.parcelas) > 1 ? 's' : ''})` : ''}`
    : `✅ <b>Conta paga</b> — ${nome}`];
  L.push(`💰 <b>${BRL(valor)}</b>${b.conta ? ` · 🏦 ${esc(b.conta)}` : ''}`);
  const venc = ddmm(b.vencimento);
  const linhaEmp = [b.empresa && !b.fatura ? `🏢 ${esc(b.empresa)}` : '', venc ? (b.atrasada ? `⚠️ estava atrasada (venceu ${venc})` : `vence ${venc}`) : ''].filter(Boolean).join(' · ');
  if (linhaEmp) L.push(linhaEmp);
  const f = b.faltam_hoje;
  if (f && Number.isFinite(Number(f.n))) {
    L.push(Number(f.n) > 0 ? `📅 Hoje ainda falta${Number(f.n) > 1 ? 'm' : ''} ${Number(f.n)} conta${Number(f.n) > 1 ? 's' : ''} — ${BRL(f.valor)}` : '🎉 Todas as contas de hoje pagas!');
  }
  L.push('📱 Dívidas do Dia');
  return L.join('\n');
}

module.exports = { textoAvisoPagamento };
