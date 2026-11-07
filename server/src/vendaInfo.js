// Linhas extras do aviso "🛒 Nova venda!" (v173, pedido do usuário) — funções
// PURAS (testadas em test/vendaInfo.test.js); as consultas ficam no worker
// (handleOrder). Ver .claude/workers.md (orders_v2) e business-rules.md.
//   • ritmo do anúncio  — "📈 3ª venda deste anúncio hoje · 21 nos últimos 7 dias"
//   • cobertura         — "· dá para ~5 dias" (estoque ÷ unidades/dia vendidas)
//   • conversão         — "👁️ Visitas 30 dias: 1.240 · conversão 2,1%"
//   • promoção          — "🏷️ Em promoção −15% (de R$ 92,90)"
//   • buy box (v174)    — "📉 Buy Box: PERDENDO para concorrente a R$ 74,90 · ..."

const BRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const INT = (v) => Math.round(Number(v) || 0).toLocaleString('pt-BR');

// hoje = pedidos do anúncio hoje (já contando esta venda); d7 = últimos 7 dias.
function linhaRitmo({ hoje, d7 }) {
  hoje = Number(hoje) || 0; d7 = Number(d7) || 0;
  if (hoje < 1) return '';
  return `📈 <b>${hoje}ª venda</b> deste anúncio hoje · ${INT(d7)} nos últimos 7 dias`;
}

// Cobertura: estoque ÷ (unidades vendidas na janela ÷ dias da janela).
// diasJanela = dias desde a 1ª venda dentro dos 30 dias (anúncio novo não
// fica com velocidade diluída), mínimo 1, máximo 30.
function textoCobertura({ estoque, unidades, diasJanela }) {
  const est = Number(estoque), un = Number(unidades) || 0;
  const dias = Math.min(30, Math.max(1, Number(diasJanela) || 30));
  if (!Number.isFinite(est) || est <= 0 || un <= 0) return '';
  const porDia = un / dias;
  const cobre = est / porDia;
  if (cobre < 1) return ' · <b>acaba hoje</b> no ritmo atual';
  if (cobre > 90) return ' · dá para mais de 90 dias';
  return ` · dá para <b>~${Math.round(cobre)} dia${Math.round(cobre) === 1 ? '' : 's'}</b>`;
}

// visitas = item_seo_score.visits_30d (sync diário); pedidos30 = pedidos do anúncio em 30 dias.
function linhaConversao({ visitas, pedidos30 }) {
  const v = Number(visitas);
  if (!Number.isFinite(v) || v <= 0) return '';
  const pct = ((Number(pedidos30) || 0) / v) * 100;
  return `👁️ Visitas 30 dias: ${INT(v)} · conversão ${pct.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// Promoção: preço cheio do item no pedido (order_items[].full_unit_price) > preço pago.
function linhaPromocao({ unitPrice, fullPrice }) {
  const p = Number(unitPrice), f = Number(fullPrice);
  if (!(p > 0) || !(f > p)) return '';
  const desc = Math.round((1 - p / f) * 100);
  if (desc < 1) return '';
  return `🏷️ Em promoção <b>−${desc}%</b> (de ${BRL(f)})`;
}

// Buy Box (v174, pedido do usuário) — mesma classificação do Rankeamento/relatório
// (js/buyboxStatus.js). cc = linha de catalog_competition; sem linha, aguardando
// 1º sync ou sem concorrência → não mostra. Dado com mais de 1 h ganha "(conferido há X)".
const { classificar } = require('../../js/buyboxStatus');
function idade(calculadoEm, agora = Date.now()) {
  const min = Math.floor((agora - new Date(calculadoEm).getTime()) / 60000);
  if (!(min >= 60)) return '';
  return min < 1440 ? ` <i>(conferido há ${Math.floor(min / 60)}h)</i>` : ` <i>(conferido há ${Math.floor(min / 1440)} dia${min >= 2880 ? 's' : ''})</i>`;
}
function linhaBuybox(cc, agora = Date.now()) {
  if (!cc) return '';
  const k = classificar({ calculado_em: cc.calculated_at, winner_item_id: cc.winner_item_id, item_id: cc.item_id, status: cc.status }).chave;
  const quando = idade(cc.calculated_at, agora);
  if (k === 'ganhando') return `🏆 Buy Box: <b>ganhando</b>${quando}`;
  if (k === 'compartilhando') return `🤝 Buy Box: <b>dividindo o 1º lugar</b>${quando}`;
  if (k !== 'perdendo') return '';
  const win = Number(cc.winner_price), ptw = Number(cc.price_to_win), meu = Number(cc.current_price);
  return `📉 Buy Box: <b>PERDENDO</b>${win > 0 ? ` para concorrente a <b>${BRL(win)}</b>` : ''}`
    + (meu > 0 ? ` · seu preço ${BRL(meu)}` : '')
    + (ptw > 0 ? ` · para ganhar: <b>${BRL(ptw)}</b>` : '')
    + ` — vendeu mesmo perdendo, rever preço${quando}`;
}

module.exports = { linhaRitmo, textoCobertura, linhaConversao, linhaPromocao, linhaBuybox };
