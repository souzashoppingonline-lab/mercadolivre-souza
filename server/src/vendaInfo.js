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
function diasCobertura({ estoque, unidades, diasJanela }) {
  const est = Number(estoque), un = Number(unidades) || 0;
  const dias = Math.min(30, Math.max(1, Number(diasJanela) || 30));
  if (!Number.isFinite(est) || est <= 0 || un <= 0) return null;
  return est / (un / dias);
}
function textoCobertura(args) {
  const cobre = diasCobertura(args);
  if (cobre == null) return '';
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
function chaveBuybox(cc) {
  return cc ? classificar({ calculado_em: cc.calculated_at, winner_item_id: cc.winner_item_id, item_id: cc.item_id, status: cc.status }).chave : null;
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

// ── Sugestão de preço (v175, pedido do usuário) ──────────────────────────────
// `linha` = saída de vendaMargem.calcularMargemLinha (fórmula única de margem).
// Simula outro preço unitário mantendo custo e fretes fixos e escalando tarifa
// e imposto na proporção do faturamento — aproximação (a tarifa fixa do ML
// abaixo de R$ 79 e a faixa de frete grátis não são recalculadas) → "~".
const SUBIR_PCT = 5;           // quanto sugerir subir quando vende rápido com estoque baixo
const COBERTURA_MAX_DIAS = 7;  // "estoque baixo" = acaba em até 7 dias no ritmo atual
const VELOCIDADE_MIN = 1;      // "vende muito" = pelo menos 1 unidade/dia (média 30 dias)

function simularPreco(linha, novoUnit) {
  const q = Number(linha.quantity) || 1;
  const fat = Number(linha.faturamento) || 0;
  if (!(fat > 0) || !(novoUnit > 0)) return null;
  const fatNovo = novoUnit * q, f = fatNovo / fat;
  const margem = fatNovo - Number(linha.custo || 0) - Number(linha.imposto || 0) * f - Number(linha.tarifa || 0) * f
    - Number(linha.frete_comprador || 0) - Number(linha.freteVend || 0);
  return { margem, pct: (margem / fatNovo) * 100 };
}
const pctTxt = (v) => `${Math.round(v)}%`;
const margemTxt = (m, p) => `${m < 0 ? '−' : ''}${BRL(Math.abs(m))} (${pctTxt(p)})`;

// ctx: { linha, buybox: {chave, price_to_win}, cobertura (dias|null), unidadesDia, promo (bool) }
function linhaSugestaoPreco({ linha, buybox, cobertura, unidadesDia, promo }) {
  if (!linha) return '';
  const q = Number(linha.quantity) || 1;
  const unit = (Number(linha.faturamento) || 0) / q;
  if (!(unit > 0)) return '';
  const semCusto = !!linha.custo_ausente;
  const atual = `~${margemTxt(Number(linha.margem), Number(linha.mc_pct))}`;

  // A) Perdendo o Buy Box → quanto a margem cairia no preço pra ganhar.
  const ptw = Number(buybox?.price_to_win);
  if (buybox?.chave === 'perdendo' && ptw > 0 && ptw < unit) {
    const desc = Math.round((1 - ptw / unit) * 100);
    if (semCusto) return `💡 Para ganhar o Buy Box: <b>${BRL(ptw)}</b> (−${desc}%) · cadastre o custo do produto para ver a margem`;
    const sim = simularPreco(linha, ptw);
    if (!sim) return '';
    return `💡 Baixar para <b>${BRL(ptw)}</b> (−${desc}%) para ganhar o Buy Box: margem ${atual} → <b>~${margemTxt(sim.margem, sim.pct)}</b>`
      + (sim.margem < 0 ? ' ⛔ <b>daria prejuízo — não compensa</b>' : '');
  }

  // B) Vende rápido e o estoque está acabando → dá para subir o preço.
  if (buybox?.chave !== 'perdendo' && cobertura != null && cobertura <= COBERTURA_MAX_DIAS && Number(unidadesDia) >= VELOCIDADE_MIN) {
    const dias = cobertura < 1 ? 'acaba hoje' : `acaba em ~${Math.round(cobertura)} dia${Math.round(cobertura) === 1 ? '' : 's'}`;
    const novo = Math.round(unit * (1 + SUBIR_PCT / 100) * 100) / 100;
    const acao = promo ? 'dá para encerrar a promoção ou subir o preço' : 'dá para subir o preço';
    if (semCusto) return `💡 Vende rápido e o estoque ${dias}: ${acao} — ex.: +${SUBIR_PCT}% → <b>${BRL(novo)}</b>`;
    const sim = simularPreco(linha, novo);
    if (!sim) return '';
    return `💡 Vende rápido e o estoque ${dias}: ${acao} — ex.: +${SUBIR_PCT}% → <b>${BRL(novo)}</b>, margem ${atual} → <b>~${margemTxt(sim.margem, sim.pct)}</b>`;
  }
  return '';
}

module.exports = { chaveBuybox, linhaRitmo, textoCobertura, diasCobertura, linhaConversao, linhaPromocao, linhaBuybox,
  simularPreco, linhaSugestaoPreco, SUBIR_PCT, COBERTURA_MAX_DIAS, VELOCIDADE_MIN };
