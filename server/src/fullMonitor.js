// Monitor do Full (v190) — anúncio que SAIU do Full ou ficou com estoque ZERO no Full.
// Regras e textos puros (testáveis); o I/O (banco, Redis, Telegram) fica no worker:
//   - handleItem (webhook de item): avisa na hora a transição (saiu / zerou).
//   - syncPrecos (05:00, getItem de todo anúncio): pega a saída do Full que não teve webhook.
//   - checkFullResumo (08:40): resumo do dia — todos os Full zerados + quem saiu nas últimas 24h.
// Telegram `tg_full` (aparece na Tela Telegram como os demais). Ver .claude/business-rules.md.

const FULL = 'fulfillment';
const RESUMO_MAX_LINHAS = 20;

// Transição entre o estado gravado (prev) e o novo do anúncio.
//   'saiu_full'  → era fulfillment e passou a outra logística
//   'entrou_full' → tinha outra logística e passou a fulfillment
//   'zerou_full' → é fulfillment e o estoque chegou a 0 (só quando antes tinha estoque,
//                  ou quando não se conhece o anterior — evita repetir a cada webhook)
function eventoFull({ prevTipo, novoTipo, prevQtd, novaQtd } = {}) {
  if (prevTipo === FULL && novoTipo && novoTipo !== FULL) return 'saiu_full';
  if (prevTipo && prevTipo !== FULL && novoTipo === FULL) return 'entrou_full';   // só registra (resumo/tela), sem aviso na hora
  if (novoTipo === FULL && novaQtd != null && Number(novaQtd) <= 0 && (prevQtd == null || Number(prevQtd) > 0)) return 'zerou_full';
  return null;
}

const LOGISTICA = { fulfillment: 'Full', self_service: 'Flex', xd_drop_off: 'Mercado Envios', cross_docking: 'Mercado Envios (coleta)', drop_off: 'Mercado Envios', me2: 'Mercado Envios', me1: 'ME1' };
const nomeLogistica = (t) => LOGISTICA[t] || t || '—';
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ritmo = (u30) => (Number(u30) > 0 ? ` · vendia ~${(Number(u30) / 30).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}/dia` : '');

function textoAvisoFull(evento, { titulo, loja, itemId, permalink, novoTipo, vendas30d } = {}) {
  const link = permalink ? `\n🔗 ${permalink}` : '';
  if (evento === 'saiu_full') {
    return `🚚 <b>Anúncio SAIU do Full</b>\n🏪 ${esc(loja)}\n📦 ${esc(titulo)}\n🔁 Full → <b>${esc(nomeLogistica(novoTipo))}</b>${ritmo(vendas30d)}\n🆔 ${esc(itemId)}${link}`;
  }
  if (evento === 'zerou_full') {
    return `🔴 <b>Estoque ZERADO no Full</b>\n🏪 ${esc(loja)}\n📦 ${esc(titulo)}\n📉 0 unidades no Full — o anúncio para de vender${ritmo(vendas30d)}\n➡️ Enviar reposição para o Full\n🆔 ${esc(itemId)}${link}`;
  }
  return '';
}

// Resumo diário: zerados = anúncios Full com 0 un.; saidas = trocas de logística nas últimas 24h.
function textoResumoFull({ zerados = [], saidas = [], entradas = [] } = {}) {
  if (!zerados.length && !saidas.length && !entradas.length) return '';
  const linha = (r, extra) => `• <b>${esc(String(r.titulo || '').slice(0, 70))}</b> · ${esc(r.loja)}${extra}`;
  const partes = ['🏭 <b>Full — resumo do dia</b>'];
  if (zerados.length) {
    partes.push(`\n🔴 <b>Estoque zerado no Full (${zerados.length})</b> — enviar reposição:`);
    zerados.slice(0, RESUMO_MAX_LINHAS).forEach((r) => partes.push(linha(r, ritmo(r.vendas30d))));
    if (zerados.length > RESUMO_MAX_LINHAS) partes.push(`+${zerados.length - RESUMO_MAX_LINHAS} outro(s)`);
  }
  if (saidas.length) {
    partes.push(`\n🚚 <b>Saíram do Full nas últimas 24h (${saidas.length})</b>:`);
    saidas.slice(0, RESUMO_MAX_LINHAS).forEach((r) => partes.push(linha(r, ` · agora ${esc(nomeLogistica(r.novoTipo))}`)));
    if (saidas.length > RESUMO_MAX_LINHAS) partes.push(`+${saidas.length - RESUMO_MAX_LINHAS} outro(s)`);
  }
  if (entradas.length) {
    partes.push(`\n✅ <b>Entraram no Full nas últimas 24h (${entradas.length})</b>:`);
    entradas.slice(0, RESUMO_MAX_LINHAS).forEach((r) => partes.push(linha(r, '')));
    if (entradas.length > RESUMO_MAX_LINHAS) partes.push(`+${entradas.length - RESUMO_MAX_LINHAS} outro(s)`);
  }
  return partes.join('\n');
}

module.exports = { FULL, eventoFull, textoAvisoFull, textoResumoFull, nomeLogistica, RESUMO_MAX_LINHAS };
