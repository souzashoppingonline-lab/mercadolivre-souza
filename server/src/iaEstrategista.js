// IA Estrategista de Performance por Anúncio — MOTOR DETERMINÍSTICO (puro,
// testado em test/iaEstrategista.test.js). Recebe as métricas JÁ consolidadas
// no backend (routes/iaEstrategista.js → séries diárias de vendas/margem/
// visitas de cada anúncio do Rankeamento) e devolve, por anúncio:
// classificações (A–G), prioridade 0–100 EXPLICÁVEL (fatores com pontos),
// nota de qualidade (separada da prioridade), problemas (comprovado ×
// hipótese), plano de ação ordenado, meta sugerida (estimativa), indicadores a
// acompanhar e o que está faltando de dado. A camada de LLM
// (ai/iaEstrategistaNarrativa.js) só INTERPRETA este resultado — nunca
// recalcula. Regras/limiares: .claude/business-rules.md ("IA Estrategista").
//
// Estágio = estágio ATUAL do anúncio (ranking_ads.fase). Não existe histórico
// confiável de estágio, então as vendas do período NÃO significam que o
// anúncio estava nesse estágio quando vendeu (ver decisions.md).

const LIM = {
  QUEDA_PEDIDOS_PCT: -30,     // B: queda de pedidos vs período anterior equivalente
  MIN_PEDIDOS_ANT_QUEDA: 4,   // B: só com base anterior relevante
  CRESC_ESCALAR_PCT: 10,      // E: crescimento consistente
  MIN_PEDIDOS_ESCALAR: 5,
  MIN_PEDIDOS_RENTAB: 5,      // D: vendas relevantes
  VISITAS_MIN_CONV: 100,      // C: só julga conversão com volume de visitas
  CONV_FATOR_BAIXA: 0.6,      // C: conversão < 60% da referência comparável
  CONV_ABS_BAIXA: 1.0,        // C: sem referência confiável → limiar absoluto (hipótese)
  COBERTURA_CRITICA: 7,       // F: dias de estoque
  COBERTURA_ATENCAO: 15,
  COBERTURA_ESCALAR: 30,      // E/A: não escalar sem 30 dias de estoque
  PEER_MIN: 5,                // comparação só com grupo de ≥5 anúncios
  AMOSTRA_MIN: 3,             // pedidos (atual+anterior) abaixo disso = amostra pequena
};
const FASE_NOME = { rankeando: 'Em rankeamento', ranqueado: 'Ranqueado', monitoramento: 'Monitoramento', recuperacao: 'Recuperação', catalogo: 'Catálogo (Buy Box)' };
const CATEGORIAS = {
  F: { chave: 'estoque', nome: 'Atenção ao estoque', ico: '📦' },
  B: { chave: 'recuperar', nome: 'Recuperar vendas', ico: '📉' },
  G: { chave: 'reduzir_investimento', nome: 'Reduzir investimento', ico: '✂️' },
  D: { chave: 'rentabilidade', nome: 'Melhorar rentabilidade', ico: '💰' },
  C: { chave: 'conversao', nome: 'Melhorar conversão', ico: '🎯' },
  E: { chave: 'escalar', nome: 'Escalar', ico: '🚀' },
  A: { chave: 'aumentar_vendas', nome: 'Aumentar vendas', ico: '📈' },
};
const SAUDAVEL = { chave: 'saudavel', nome: 'Saudável / sem ação urgente', ico: '✅' };
const SEM_DADOS = { chave: 'dados_insuficientes', nome: 'Dados insuficientes', ico: '❔' };

const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const BRL = n => (n == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n));
const PCT = n => (n == null ? '—' : `${r1(n).toLocaleString('pt-BR')}%`);
const addDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mediana = arr => { const a = arr.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const varPct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);

// Soma a série diária { 'YYYY-MM-DD': {pedidos, unidades, fat, margem, custo, tarifa, frete} } numa janela.
function somar(dias, visitas, ini, fim) {
  const s = { pedidos: 0, unidades: 0, fat: 0, margem: 0, custo: 0, tarifa: 0, frete: 0, visitas: 0 };
  for (let d = ini; d <= fim; d = addDias(d, 1)) {
    const x = dias[d];
    if (x) { s.pedidos += x.pedidos || 0; s.unidades += x.unidades || 0; s.fat += x.fat || 0; s.margem += x.margem || 0; s.custo += x.custo || 0; s.tarifa += x.tarifa || 0; s.frete += x.frete || 0; }
    if (visitas && visitas[d] != null) s.visitas += Number(visitas[d]) || 0;
  }
  return s;
}

// Métricas de 1 anúncio. `fim` = último dia FECHADO (ontem); período = N dias.
function metricas(a, periodo, fim) {
  const ini = addDias(fim, -(periodo - 1));
  const cur = somar(a.dias || {}, a.visitas, ini, fim);
  const prev = somar(a.dias || {}, a.visitas, addDias(ini, -periodo), addDias(ini, -1));
  const temVisitas = Object.keys(a.visitas || {}).length > 0;
  const custoOk = !a.custo_ausente;
  const mc = (s) => (custoOk && s.fat > 0 ? (s.margem / s.fat) * 100 : null);
  const conv = (s) => (temVisitas && s.visitas > 0 ? (s.pedidos / s.visitas) * 100 : null);
  const janelas = {};
  for (const n of [7, 14, 30]) {
    const c = somar(a.dias || {}, a.visitas, addDias(fim, -(n - 1)), fim);
    const p = somar(a.dias || {}, a.visitas, addDias(fim, -(2 * n - 1)), addDias(fim, -n));
    janelas[n] = { pedidos: c.pedidos, pedidos_ant: p.pedidos, fat: r2(c.fat), fat_ant: r2(p.fat), var_pedidos: r1(varPct(c.pedidos, p.pedidos)), var_fat: r1(varPct(c.fat, p.fat)) };
  }
  const s30 = somar(a.dias || {}, null, addDias(fim, -29), fim);
  const vendaDia = s30.unidades / 30;
  const estoque = a.estoque == null ? null : Number(a.estoque);
  const m = {
    periodo, de: ini, ate: fim,
    pedidos: cur.pedidos, pedidos_ant: prev.pedidos, unidades: cur.unidades, unidades_ant: prev.unidades,
    fat: r2(cur.fat), fat_ant: r2(prev.fat), margem: custoOk ? r2(cur.margem) : null, margem_ant: custoOk ? r2(prev.margem) : null,
    mc_pct: r1(mc(cur)), mc_pct_ant: r1(mc(prev)),
    ticket: cur.pedidos ? r2(cur.fat / cur.pedidos) : null, ticket_ant: prev.pedidos ? r2(prev.fat / prev.pedidos) : null,
    lucro_pedido: custoOk && cur.pedidos ? r2(cur.margem / cur.pedidos) : null,
    visitas: temVisitas ? cur.visitas : null, visitas_ant: temVisitas ? prev.visitas : null,
    conversao: r2(conv(cur)), conversao_ant: r2(conv(prev)),
    var_pedidos: r1(varPct(cur.pedidos, prev.pedidos)), var_fat: r1(varPct(cur.fat, prev.fat)),
    var_visitas: temVisitas ? r1(varPct(cur.visitas, prev.visitas)) : null,
    var_conversao_pp: conv(cur) != null && conv(prev) != null ? r2(conv(cur) - conv(prev)) : null,
    var_mc_pp: mc(cur) != null && mc(prev) != null ? r1(mc(cur) - mc(prev)) : null,
    var_ticket: r1(varPct(cur.pedidos ? cur.fat / cur.pedidos : 0, prev.pedidos ? prev.fat / prev.pedidos : 0)),
    // composição do custo (pra apontar onde a margem some)
    pct_custo: cur.fat > 0 && custoOk ? r1((cur.custo / cur.fat) * 100) : null,
    pct_tarifa: cur.fat > 0 ? r1((cur.tarifa / cur.fat) * 100) : null,
    pct_frete: cur.fat > 0 ? r1((cur.frete / cur.fat) * 100) : null,
    preco_unit: cur.unidades ? r2(cur.fat / cur.unidades) : (a.preco != null ? Number(a.preco) : null),
    margem_unit: custoOk && cur.unidades ? r2(cur.margem / cur.unidades) : null,
    venda_dia_30: r2(vendaDia), fat_30: r2(s30.fat), unidades_30: s30.unidades,
    estoque, cobertura_dias: estoque != null && vendaDia > 0 ? r1(estoque / vendaDia) : null,
    janelas,
  };
  return m;
}

// Referências comparáveis: mediana do MESMO estágio com ≥ PEER_MIN anúncios;
// sem isso, mediana de todos os anúncios do Rankeamento (justificado no
// texto); sem isso, nenhuma (não usa média de grupo pequeno).
function referencias(lista) {
  const grupo = (itens, nome) => {
    const convs = itens.filter(x => x.m.visitas >= LIM.VISITAS_MIN_CONV && x.m.conversao != null).map(x => x.m.conversao);
    const mcs = itens.filter(x => x.m.pedidos >= LIM.AMOSTRA_MIN && x.m.mc_pct != null).map(x => x.m.mc_pct);
    const peds = itens.map(x => x.m.pedidos);
    const vis = itens.filter(x => x.m.visitas != null).map(x => x.m.visitas);
    return {
      nome,
      conversao: convs.length >= LIM.PEER_MIN ? r2(mediana(convs)) : null, n_conversao: convs.length,
      mc_pct: mcs.length >= LIM.PEER_MIN ? r1(mediana(mcs)) : null, n_mc: mcs.length,
      pedidos: peds.length >= LIM.PEER_MIN ? mediana(peds) : null,
      visitas: vis.length >= LIM.PEER_MIN ? mediana(vis) : null, n: itens.length,
    };
  };
  const geral = grupo(lista, 'todos os anúncios do Rankeamento');
  const porFase = {};
  for (const f of Object.keys(FASE_NOME)) porFase[f] = grupo(lista.filter(x => x.a.fase === f), `anúncios do estágio ${FASE_NOME[f]}`);
  // Por campo: usa o do estágio se confiável, senão o geral (com o nome do grupo usado).
  const escolher = (fase) => {
    const pf = porFase[fase] || {};
    const pick = (campo) => (pf[campo] != null ? { valor: pf[campo], grupo: pf.nome } : geral[campo] != null ? { valor: geral[campo], grupo: geral.nome } : null);
    return { conversao: pick('conversao'), mc_pct: pick('mc_pct'), pedidos: pick('pedidos'), visitas: pick('visitas') };
  };
  return { geral, porFase, escolher };
}

// Impacto de reduzir o preço em Δ na MC (aproximação: tarifa % e imposto
// mudam junto com o preço — ignorados, por isso "aprox."). Regra 2: nunca
// recomendar baixar preço sem mostrar isso.
function mcComNovoPreco(m, novoPreco) {
  if (m.preco_unit == null || m.margem_unit == null || !(novoPreco > 0)) return null;
  const delta = m.preco_unit - novoPreco;
  return r1(((m.margem_unit - delta) / novoPreco) * 100);
}

function analisarAnuncio(a, m, ref, cfg) {
  const minima = Number(a.margem_minima_pct ?? cfg.margem_minima_pct ?? 10);
  const alvo = Number(a.margem_alvo_pct ?? cfg.margem_alvo_pct ?? 20);
  const mcBoa = (minima + alvo) / 2;
  const escala = 30 / m.periodo; // normaliza impacto pra "por mês"
  const problemas = [], oportunidades = [], acoes = [], faltando = [], cats = [];
  const add = (cat, sev, impacto, extra = {}) => cats.push({ cat, sev, impacto: impacto != null && impacto > 0 ? r2(impacto) : 0, ...extra });

  if (a.custo_ausente) faltando.push('Custo do produto não cadastrado — margem de contribuição desconhecida (cadastre o custo para liberar as análises de margem, preço e ADS).');
  if (m.visitas == null) faltando.push('Sem visitas registradas para este anúncio — conversão indisponível.');
  if (a.ads == null || (a.ads.investido == null && a.ads.roas == null && a.ads.orcamento_diario == null)) faltando.push('Investimento em publicidade não informado no card do Rankeamento (ADS investido / ROAS / orçamento).');
  if (a.fase === 'catalogo' && !a.buybox) faltando.push('Sem dado de Buy Box ainda para este anúncio de catálogo.');
  if (m.estoque == null) faltando.push('Estoque do anúncio desconhecido.');
  const amostraPequena = (m.pedidos + m.pedidos_ant) < LIM.AMOSTRA_MIN;
  const refConv = ref.conversao, refMc = ref.mc_pct;
  const roasMin = m.mc_pct != null && m.mc_pct > 0 ? r2(100 / m.mc_pct) : null;

  // ── F. Estoque ──
  let estoqueBloqueia = false;
  if (m.venda_dia_30 > 0 && m.estoque != null) {
    const reposicao = Math.max(0, Math.ceil(m.venda_dia_30 * 30 - m.estoque));
    if (m.estoque <= 0) {
      estoqueBloqueia = true;
      problemas.push({ texto: `Sem estoque, e o anúncio vendia ${r1(m.venda_dia_30)} un/dia nos últimos 30 dias.`, tipo: 'comprovado' });
      add('F', 30, m.fat_30, { critico: true });
      acoes.push({ acao: `Repor estoque imediatamente: ~${reposicao} un para 30 dias de cobertura.`, motivo: `Cada dia parado perde ~${BRL(m.venda_dia_30 * (m.preco_unit || 0))} de faturamento.`, cat: 'F', risco: 'baixo', impacto: m.fat_30 });
    } else if (m.cobertura_dias < LIM.COBERTURA_ATENCAO) {
      estoqueBloqueia = m.cobertura_dias < LIM.COBERTURA_ESCALAR;
      const critico = m.cobertura_dias < LIM.COBERTURA_CRITICA;
      problemas.push({ texto: `Estoque cobre só ${m.cobertura_dias} dia(s) (${m.estoque} un ÷ ${r1(m.venda_dia_30)} un/dia).`, tipo: 'comprovado' });
      const perda = Math.max(0, 30 - m.cobertura_dias) * m.venda_dia_30 * (m.preco_unit || 0);
      add('F', critico ? 28 : 18, perda, { critico });
      acoes.push({ acao: `Priorizar compra do fornecedor: ~${reposicao} un para chegar a 30 dias de cobertura.`, motivo: `Ruptura em ~${Math.floor(m.cobertura_dias)} dia(s) no ritmo atual.`, cat: 'F', risco: 'baixo', impacto: perda });
      acoes.push({ acao: 'Não aumentar publicidade nem baixar preço até repor (aceleraria a ruptura).', motivo: 'Regra: nunca escalar sem estoque.', cat: 'F', risco: 'baixo', impacto: 0 });
    } else if (m.cobertura_dias < LIM.COBERTURA_ESCALAR) estoqueBloqueia = true;
  }

  // ── B. Recuperar ──
  if (m.pedidos_ant >= LIM.MIN_PEDIDOS_ANT_QUEDA && m.var_pedidos != null && m.var_pedidos <= LIM.QUEDA_PEDIDOS_PCT) {
    problemas.push({ texto: `Pedidos caíram de ${m.pedidos_ant} para ${m.pedidos} (${PCT(m.var_pedidos)}) — ${m.periodo} dias vs ${m.periodo} dias anteriores.`, tipo: 'comprovado' });
    const perda = Math.max(0, (m.fat_ant - m.fat) * escala);
    add('B', 15 + 15 * Math.min(1, Math.abs(m.var_pedidos) / 80), perda);
    if (m.var_visitas != null && m.var_visitas <= -20) {
      problemas.push({ texto: `Visitas caíram ${PCT(m.var_visitas)} — a queda vem de exposição (menos gente vendo o anúncio).`, tipo: 'comprovado' });
      acoes.push({ acao: 'Revisar título e atributos (ficha técnica completa) para recuperar relevância na busca.', motivo: `Visitas ${m.visitas_ant} → ${m.visitas}.`, cat: 'B', risco: 'baixo', impacto: perda * 0.5 });
    }
    if (m.var_conversao_pp != null && m.var_conversao_pp <= -0.5) {
      problemas.push({ texto: `Conversão caiu ${r2(Math.abs(m.var_conversao_pp))} p.p. (${PCT(m.conversao_ant)} → ${PCT(m.conversao)}) — as pessoas veem, mas compram menos.`, tipo: 'comprovado' });
      problemas.push({ texto: 'Causa provável: preço ou condição de entrega menos competitivos que a concorrência (não confirmado — verificar).', tipo: 'hipotese' });
      acoes.push({ acao: 'Comparar preço e prazo de entrega com os 5 principais concorrentes do mesmo produto.', motivo: 'Queda de conversão com visitas estáveis costuma ser oferta (preço/frete/prazo).', cat: 'B', risco: 'baixo', impacto: perda * 0.5 });
    }
    if (a.buybox && a.buybox.chave === 'perdendo') {
      const pw = a.buybox.price_to_win != null ? Number(a.buybox.price_to_win) : null;
      const novaMc = pw != null ? mcComNovoPreco(m, pw) : null;
      problemas.push({ texto: `Perdendo o Buy Box${a.buybox.winner_price != null ? ` (vencedor a ${BRL(Number(a.buybox.winner_price))})` : ''}.`, tipo: 'comprovado' });
      if (pw != null) acoes.push({ acao: `Avaliar preço para ganhar o Buy Box: ${BRL(pw)}${novaMc != null ? ` — MC estimada cairia para ${PCT(novaMc)} (aprox.)` : ' (custo não cadastrado: impacto na margem desconhecido)'}.`, motivo: novaMc != null && novaMc < minima ? `Atenção: abaixo da margem mínima de ${PCT(minima)} — só vale se o volume compensar.` : 'Preço informado pelo Mercado Livre (price_to_win).', cat: 'B', risco: novaMc != null && novaMc < minima ? 'alto' : 'medio', impacto: perda * 0.6 });
    }
    if (!acoes.some(x => x.cat === 'B')) {
      problemas.push({ texto: 'Sem sinal claro nos dados de visitas/conversão/Buy Box — a causa precisa ser investigada.', tipo: 'hipotese' });
      acoes.push({ acao: 'Revisar imagem principal, preço vs concorrência e reputação/prazo de entrega do anúncio.', motivo: 'Queda comprovada, causa não identificável pelos dados disponíveis.', cat: 'B', risco: 'baixo', impacto: perda * 0.3 });
    }
  }

  // ── G. Reduzir investimento ──
  const temAds = a.ads && ((Number(a.ads.investido) || 0) > 0 || (Number(a.ads.orcamento_diario) || 0) > 0);
  if (temAds && !a.custo_ausente) {
    const roas = a.ads.roas != null ? Number(a.ads.roas) : null;
    if (m.mc_pct != null && m.mc_pct <= 0) {
      problemas.push({ texto: `Margem negativa (${PCT(m.mc_pct)}) com publicidade ativa — cada venda impulsionada aumenta o prejuízo.`, tipo: 'comprovado' });
      const perda = a.ads.orcamento_diario ? Number(a.ads.orcamento_diario) * 30 : null;
      add('G', 25, perda);
      acoes.push({ acao: 'Pausar ou reduzir fortemente o orçamento de ADS até corrigir preço/custo.', motivo: 'ADS em produto com MC ≤ 0.', cat: 'G', risco: 'baixo', impacto: perda || 0 });
    } else if (roas != null && roasMin != null && roas < roasMin) {
      problemas.push({ texto: `ROAS ${r2(roas)} abaixo do mínimo de equilíbrio ${roasMin} (= 100 ÷ MC ${PCT(m.mc_pct)}) — o ADS custa mais do que a margem que gera.`, tipo: 'comprovado' });
      const perda = a.ads.orcamento_diario ? Number(a.ads.orcamento_diario) * 30 * (1 - roas / roasMin) : null;
      add('G', 20, perda);
      acoes.push({ acao: `Reduzir o orçamento diário${a.ads.orcamento_diario ? ` (hoje ${BRL(Number(a.ads.orcamento_diario))})` : ''} ou revisar a campanha até o ROAS passar de ${roasMin}.`, motivo: 'ROAS abaixo do equilíbrio.', cat: 'G', risco: 'baixo', impacto: perda || 0 });
    }
  }

  // ── D. Rentabilidade ──
  if (m.pedidos >= LIM.MIN_PEDIDOS_RENTAB && m.mc_pct != null && m.mc_pct < minima) {
    problemas.push({ texto: `MC de ${PCT(m.mc_pct)} (${BRL(m.margem)} em ${m.pedidos} pedidos) abaixo da margem mínima de ${PCT(minima)}.`, tipo: 'comprovado' });
    const ganho = m.fat * (minima - m.mc_pct) / 100 * escala;
    add('D', m.mc_pct < 0 ? 25 : 18, ganho);
    const comp = [['custo do produto', m.pct_custo], ['tarifa do ML', m.pct_tarifa], ['frete', m.pct_frete]].filter(x => x[1] != null).sort((x, y) => y[1] - x[1]);
    if (comp.length) problemas.push({ texto: `Maior peso no faturamento: ${comp.map(c => `${c[0]} ${PCT(c[1])}`).join(' · ')}.`, tipo: 'comprovado' });
    if (m.preco_unit && m.margem_unit != null) {
      const precoAlvo = r2((m.preco_unit - m.margem_unit) / (1 - minima / 100));
      acoes.push({ acao: `Reavaliar preço: para MC de ${PCT(minima)}, o preço ficaria em ~${BRL(precoAlvo)} (hoje ${BRL(m.preco_unit)}) — aprox., sem recalcular tarifa.`, motivo: 'Margem abaixo do mínimo configurado no Analista Ecom.', cat: 'D', risco: 'medio', impacto: ganho });
      const custoMax = m.pct_custo != null ? r2(m.preco_unit * (m.pct_custo / 100) - (minima - m.mc_pct) / 100 * m.preco_unit) : null;
      if (custoMax != null && custoMax > 0) acoes.push({ acao: `Negociar custo de aquisição: até ~${BRL(custoMax)}/un mantendo o preço atinge MC de ${PCT(minima)}.`, motivo: `Custo pesa ${PCT(m.pct_custo)} do faturamento.`, cat: 'D', risco: 'baixo', impacto: ganho });
    }
    if (m.pct_frete != null && m.pct_frete >= 12) acoes.push({ acao: 'Revisar frete (peso/dimensões cadastrados, logística usada) — frete acima de 12% do faturamento.', motivo: `Frete = ${PCT(m.pct_frete)} do faturamento.`, cat: 'D', risco: 'baixo', impacto: ganho * 0.3 });
    if (temAds) acoes.push({ acao: 'Reduzir publicidade ineficiente neste anúncio enquanto a margem não sobe.', motivo: 'ADS em produto abaixo da margem mínima.', cat: 'D', risco: 'baixo', impacto: 0 });
  }

  // ── C. Conversão ──
  if (m.visitas != null && m.visitas >= LIM.VISITAS_MIN_CONV && m.conversao != null) {
    const baixa = refConv ? m.conversao < refConv.valor * LIM.CONV_FATOR_BAIXA : m.conversao < LIM.CONV_ABS_BAIXA;
    if (baixa) {
      const alvoConv = refConv ? refConv.valor * 0.8 : 1.5;
      problemas.push(refConv
        ? { texto: `Conversão de ${PCT(m.conversao)} com ${m.visitas} visitas — mediana de ${refConv.grupo} é ${PCT(refConv.valor)}.`, tipo: 'comprovado' }
        : { texto: `Conversão de ${PCT(m.conversao)} com ${m.visitas} visitas — abaixo de ${PCT(LIM.CONV_ABS_BAIXA)} (sem grupo comparável confiável; limiar geral).`, tipo: 'hipotese' });
      const ganho = m.ticket ? m.visitas * (alvoConv - m.conversao) / 100 * m.ticket * escala : 0;
      add('C', 15, ganho);
      acoes.push({ acao: 'Trocar/testar a imagem principal e adicionar imagens explicativas (medidas, uso, diferenciais).', motivo: 'Visitas existem; o anúncio não convence quem entra.', cat: 'C', risco: 'baixo', impacto: ganho * 0.5 });
      acoes.push({ acao: 'Revisar preço e frete frente aos concorrentes diretos e checar avaliações/perguntas sem resposta.', motivo: `Meta: conversão perto de ${PCT(alvoConv)}.`, cat: 'C', risco: 'baixo', impacto: ganho * 0.5 });
    }
  }

  // ── E. Escalar / A. Aumentar vendas ── (regras 1 e 3: margem e estoque antes)
  const convOk = m.conversao == null || !refConv || m.conversao >= refConv.valor * 0.9;
  const adsRuim = cats.some(c => c.cat === 'G');
  if (m.mc_pct != null && m.mc_pct >= mcBoa && !adsRuim) {
    const crescendo = m.pedidos >= LIM.MIN_PEDIDOS_ESCALAR && m.pedidos_ant >= LIM.AMOSTRA_MIN && m.var_pedidos != null && m.var_pedidos >= LIM.CRESC_ESCALAR_PCT;
    if (crescendo && convOk) {
      if (estoqueBloqueia) {
        oportunidades.push({ texto: `Cresce ${PCT(m.var_pedidos)} com MC ${PCT(m.mc_pct)}, mas o estoque não sustenta escalar agora (cobertura ${m.cobertura_dias ?? '—'} dias).`, tipo: 'comprovado' });
      } else {
        oportunidades.push({ texto: `Crescimento consistente: pedidos ${m.pedidos_ant} → ${m.pedidos} (${PCT(m.var_pedidos)}) com MC ${PCT(m.mc_pct)}${m.cobertura_dias != null ? ` e ${m.cobertura_dias} dias de estoque` : ''}.`, tipo: 'comprovado' });
        const pot = m.fat * escala * 0.2;
        add('E', 10, pot);
        acoes.push({ acao: `Aumentar orçamento de ADS gradualmente (+20%${a.ads?.orcamento_diario ? `: de ${BRL(Number(a.ads.orcamento_diario))} para ${BRL(Number(a.ads.orcamento_diario) * 1.2)}/dia` : ''}) mantendo ROAS acima de ${roasMin ?? '—'}.`, motivo: `ROAS mínimo de equilíbrio = 100 ÷ MC ${PCT(m.mc_pct)}.`, cat: 'E', risco: 'medio', impacto: pot * 0.6 });
        acoes.push({ acao: 'Criar kit/variação (ex.: leve 2) e explorar novas palavras-chave no título.', motivo: 'Produto com tração e margem para crescer.', cat: 'E', risco: 'baixo', impacto: pot * 0.4 });
      }
    } else if (convOk && !cats.some(c => c.cat === 'B')) {
      const poucoVolume = ref.pedidos ? m.pedidos <= ref.pedidos.valor : m.pedidos < LIM.MIN_PEDIDOS_ESCALAR;
      const poucaVisita = ref.visitas && m.visitas != null ? m.visitas < ref.visitas.valor : null;
      if (poucoVolume && !estoqueBloqueia) {
        oportunidades.push({ texto: `Boa margem (${PCT(m.mc_pct)}) e volume baixo (${m.pedidos} pedidos em ${m.periodo} dias${ref.pedidos ? `; mediana de ${ref.pedidos.grupo}: ${ref.pedidos.valor}` : ''}).`, tipo: 'comprovado' });
        if (poucaVisita) problemas.push({ texto: `Pouca exposição: ${m.visitas} visitas (mediana de ${ref.visitas.grupo}: ${ref.visitas.valor}).`, tipo: 'comprovado' });
        else problemas.push({ texto: 'Provável baixa exposição nas buscas (não confirmado por visitas).', tipo: 'hipotese' });
        const pot = Math.max(m.fat, m.ticket || 0) * escala * 0.15;
        add('A', 8, pot);
        acoes.push({ acao: 'Revisar o título para cobrir os termos que o comprador pesquisa e completar a ficha técnica.', motivo: 'Margem boa — falta gente vendo o anúncio.', cat: 'A', risco: 'baixo', impacto: pot * 0.4 });
        acoes.push({ acao: `Testar campanha de ADS com orçamento controlado${roasMin ? ` (ROAS mínimo ${roasMin})` : ''}.`, motivo: `MC ${PCT(m.mc_pct)} permite investir com segurança.`, cat: 'A', risco: 'medio', impacto: pot * 0.4 });
        acoes.push({ acao: 'Analisar os 5 principais concorrentes (preço, fotos, frete) e melhorar a imagem principal.', motivo: 'Referência para ganhar posição.', cat: 'A', risco: 'baixo', impacto: pot * 0.2 });
      }
    }
  }

  // Categoria principal = maior severidade (empate: maior impacto).
  cats.sort((x, y) => y.sev - x.sev || y.impacto - x.impacto);
  const principal = cats[0] || null;
  const impactoTotal = r2(cats.reduce((s, c) => s + (c.impacto || 0), 0));

  // Plano ordenado: maior impacto e menor risco primeiro (regra 11); sem repetir texto.
  const pesoRisco = { baixo: 1, medio: 0.7, alto: 0.4 };
  const vistos = new Set();
  const plano = acoes.filter(x => !vistos.has(x.acao) && vistos.add(x.acao))
    .sort((x, y) => (y.impacto || 0) * pesoRisco[y.risco] - (x.impacto || 0) * pesoRisco[x.risco] || pesoRisco[y.risco] - pesoRisco[x.risco])
    .slice(0, 6).map((x, i) => ({ ordem: i + 1, ...x, impacto: r2(x.impacto || 0), categoria: CATEGORIAS[x.cat].nome }));

  return {
    categorias: [...new Set(cats.map(c => c.cat))].map(k => ({ codigo: k, ...CATEGORIAS[k] })),
    // Sem categoria e sem custo: não dá pra dizer que está "saudável" (margem desconhecida).
    principal: principal ? { codigo: principal.cat, ...CATEGORIAS[principal.cat], critico: !!principal.critico } : { codigo: null, ...(a.custo_ausente && m.pedidos > 0 ? SEM_DADOS : SAUDAVEL) },
    _cats: cats, impacto_mensal: impactoTotal, amostra_pequena: amostraPequena,
    problemas, oportunidades, plano, faltando,
    meta: meta(principal, m, { minima, refConv }),
    acompanhar: acompanhar(principal),
    referencia: { conversao: refConv, mc_pct: refMc, pedidos: ref.pedidos, visitas: ref.visitas },
    margem_minima_pct: minima, margem_alvo_pct: alvo, roas_minimo: roasMin,
  };
}

function meta(p, m, { minima, refConv }) {
  if (!p) return null;
  const est = ' (estimativa da IA, não garantida)';
  const pedSem = n => r1((n / m.periodo) * 14);
  switch (p.cat) {
    case 'F': return `Repor estoque para cobrir 30 dias${m.venda_dia_30 ? ` (~${Math.ceil(m.venda_dia_30 * 30)} un/mês no ritmo atual)` : ''} antes de qualquer ação de crescimento.`;
    case 'B': return `Recuperar metade da queda: voltar a ~${pedSem(m.pedidos + (m.pedidos_ant - m.pedidos) / 2)} pedidos a cada 14 dias${est}.`;
    case 'G': return `Levar o ROAS acima do equilíbrio${m.mc_pct > 0 ? ` (${r2(100 / m.mc_pct)})` : ''} ou zerar o ADS até a margem voltar${est}.`;
    case 'D': return `Subir a MC de ${PCT(m.mc_pct)} para pelo menos ${PCT(minima)} sem perder mais de 10% dos pedidos${est}.`;
    case 'C': return `Levar a conversão de ${PCT(m.conversao)} para ~${PCT(refConv ? refConv.valor * 0.8 : 1.5)} nos próximos 14 dias${est}.`;
    case 'E': return `Aumentar pedidos em 20% nos próximos 14 dias mantendo MC ≥ ${PCT(minima)}${est}.`;
    case 'A': return `Aumentar pedidos em 15% nos próximos 14 dias mantendo a margem de contribuição${est}.`;
    default: return null;
  }
}
function acompanhar(p) {
  const base = ['Pedidos/dia', 'Faturamento', 'MC%'];
  const extra = { F: ['Estoque e cobertura (dias)'], B: ['Visitas', 'Conversão', 'Buy Box (se catálogo)'], G: ['ROAS', 'Investimento em ADS', 'MC em R$'], D: ['MC em R$', 'Ticket médio', 'Pedidos (se o preço subir)'], C: ['Conversão', 'Visitas'], E: ['ROAS', 'Estoque (cobertura)', 'MC em R$'], A: ['Visitas', 'Conversão', 'ROAS (se testar ADS)'] };
  return p ? [...base, ...(extra[p.cat] || [])] : base;
}

// Prioridade 0–100 (separada da qualidade): impacto financeiro relativo à
// carteira + severidade + relevância + tendência, com redutor de confiança.
function prioridade(x, maxImpacto, maxFat) {
  const f = [];
  const p = x.analise._cats[0];
  if (x.analise.impacto_mensal > 0 && maxImpacto > 0) f.push({ fator: 'Impacto financeiro estimado', pontos: 35 * Math.log10(1 + x.analise.impacto_mensal) / Math.log10(1 + maxImpacto), detalhe: `${BRL(x.analise.impacto_mensal)}/mês (estimativa)` });
  if (p) f.push({ fator: `Gravidade: ${CATEGORIAS[p.cat].nome}`, pontos: p.sev, detalhe: p.critico ? 'crítico' : '' });
  if (maxFat > 0 && x.m.fat > 0) f.push({ fator: 'Relevância no faturamento da carteira', pontos: 15 * (x.m.fat / maxFat), detalhe: BRL(x.m.fat) });
  if (x.m.var_fat != null && x.m.var_fat <= -20) f.push({ fator: 'Faturamento em queda', pontos: Math.min(10, Math.abs(x.m.var_fat) / 8), detalhe: PCT(x.m.var_fat) });
  if (x.a.custo_ausente && x.m.pedidos > 0) f.push({ fator: 'Dado essencial faltando: custo não cadastrado em anúncio que vende', pontos: 15, detalhe: `${x.m.pedidos} pedidos sem margem conhecida` });
  if (x.analise.plano.some(a => a.risco === 'baixo' && a.impacto > 0)) f.push({ fator: 'Ação de baixo risco disponível', pontos: 5, detalhe: '' });
  let total = f.reduce((s, y) => s + y.pontos, 0);
  if (x.analise.amostra_pequena && total > 0) { f.push({ fator: 'Amostra pequena (poucos pedidos) — confiança menor', pontos: -total * 0.4, detalhe: `${x.m.pedidos + x.m.pedidos_ant} pedidos nos 2 períodos` }); total *= 0.6; }
  if (x.a.custo_ausente && total > 15) { f.push({ fator: 'Custo não cadastrado — análise de margem incompleta', pontos: -total * 0.15, detalhe: '' }); total *= 0.85; }
  const nota = Math.max(0, Math.min(100, Math.round(total)));
  return { nota, faixa: faixa(nota), fatores: f.map(y => ({ ...y, pontos: r1(y.pontos) })) };
}
function faixa(n) {
  if (n >= 80) return { chave: 'critico', label: 'Crítico — agir imediatamente', cor: '#f85149' };
  if (n >= 60) return { chave: 'alta', label: 'Alta prioridade', cor: '#f0883e' };
  if (n >= 40) return { chave: 'oportunidade', label: 'Oportunidade de melhoria', cor: '#d29922' };
  if (n >= 20) return { chave: 'monitorar', label: 'Monitoramento', cor: '#58a6ff' };
  return { chave: 'saudavel', label: 'Saudável / baixa prioridade', cor: '#3fb950' };
}

// Qualidade 0–100 (o anúncio está bem?) — média dos sub-scores disponíveis.
function qualidade(m, analise) {
  const lin = (v, x0, x1) => Math.max(0, Math.min(100, ((v - x0) / (x1 - x0)) * 100));
  const s = [];
  if (m.mc_pct != null) s.push(lin(m.mc_pct, 0, analise.margem_alvo_pct));
  if (m.var_pedidos != null) s.push(lin(m.var_pedidos, -50, 30));
  if (m.conversao != null && analise.referencia.conversao) s.push(lin(m.conversao / analise.referencia.conversao.valor, 0.5, 1.2));
  if (m.cobertura_dias != null) s.push(lin(m.cobertura_dias, 0, 30));
  else if (m.estoque === 0 && m.venda_dia_30 > 0) s.push(0);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
}

// Carteira inteira: anúncios = [{ ranking_ad_id, ml_id, titulo, sku, loja,
// fase, estoque, preco, custo_ausente, margem_alvo_pct, ads, buybox, dias, visitas }].
function analisarCarteira(anuncios, { periodo = 14, fim, cfg = {} } = {}) {
  const base = anuncios.map(a => ({ a, m: metricas(a, periodo, fim) }));
  const refs = referencias(base);
  base.forEach(x => { x.analise = analisarAnuncio(x.a, x.m, refs.escolher(x.a.fase), cfg); });
  const maxImpacto = Math.max(0, ...base.map(x => x.analise.impacto_mensal || 0));
  const maxFat = Math.max(0, ...base.map(x => x.m.fat || 0));
  base.forEach(x => { x.prioridade = prioridade(x, maxImpacto, maxFat); x.qualidade = qualidade(x.m, x.analise); delete x.analise._cats; });
  base.sort((x, y) => y.prioridade.nota - x.prioridade.nota || (y.analise.impacto_mensal || 0) - (x.analise.impacto_mensal || 0));
  const tem = (x, c) => x.analise.categorias.some(k => k.codigo === c);
  const lista = base.map(x => ({
    ranking_ad_id: x.a.ranking_ad_id, ml_id: x.a.ml_id, titulo: x.a.titulo, sku: x.a.sku || null, loja: x.a.loja, store_id: x.a.store_id,
    fase: x.a.fase, fase_nome: FASE_NOME[x.a.fase] || x.a.fase, thumbnail: x.a.thumbnail || null, permalink: x.a.permalink || null,
    metricas: x.m, analise: x.analise, prioridade: x.prioridade, qualidade: x.qualidade,
  }));
  const top = (filtro, n = 5) => lista.filter(filtro).slice(0, n).map(x => ({ ranking_ad_id: x.ranking_ad_id, titulo: x.titulo, prioridade: x.prioridade.nota, motivo: x.analise.problemas[0]?.texto || x.analise.oportunidades[0]?.texto || '', impacto: x.analise.impacto_mensal }));
  const potencial = r2(lista.filter(x => x.analise.categorias.some(k => ['A', 'B', 'C', 'E', 'F'].includes(k.codigo))).reduce((s, x) => s + (x.analise.impacto_mensal || 0), 0));
  const painel = {
    analisados: lista.length,
    precisam_intervencao: lista.filter(x => x.prioridade.nota >= 60).length,
    potencial_crescimento: lista.filter(x => tem(x, 'A') || tem(x, 'E')).length,
    problemas_rentabilidade: lista.filter(x => tem(x, 'D') || tem(x, 'G')).length,
    risco_ruptura: lista.filter(x => tem(x, 'F')).length,
    potencial_faturamento_mensal: potencial,
    por_categoria: Object.fromEntries(Object.keys(CATEGORIAS).map(k => [k, lista.filter(x => tem(x, k)).length])),
    referencias: { geral: refs.geral, por_fase: refs.porFase },
  };
  const ordemImpacto = (xs) => xs.slice().sort((p, q) => (q.analise.impacto_mensal || 0) - (p.analise.impacto_mensal || 0));
  const respostas = {
    prejudicando_resultado: top(x => tem(x, 'D') || tem(x, 'G') || tem(x, 'B')),
    deixando_de_vender: top(x => tem(x, 'C') || tem(x, 'F') || tem(x, 'A')),
    priorizar_hoje: top(x => x.prioridade.nota >= 60),
    merecem_investimento: top(x => tem(x, 'E') || tem(x, 'A')),
    melhoria_preco: top(x => tem(x, 'D') || x.analise.plano.some(a => /preço/i.test(a.acao))),
    melhoria_conversao: top(x => tem(x, 'C')),
    vende_muito_lucra_pouco: ordemImpacto(lista.filter(x => tem(x, 'D'))).slice(0, 5).map(x => ({ ranking_ad_id: x.ranking_ad_id, titulo: x.titulo, prioridade: x.prioridade.nota, motivo: `${BRL(x.metricas.fat)} de faturamento com MC ${PCT(x.metricas.mc_pct)}`, impacto: x.analise.impacto_mensal })),
    aumentar_faturamento: top(x => tem(x, 'A') || tem(x, 'E') || tem(x, 'B')),
    fazer_primeiro: lista.find(x => x.analise.plano.length) ? (() => { const x = lista.find(y => y.analise.plano.length); return { ranking_ad_id: x.ranking_ad_id, titulo: x.titulo, acao: x.analise.plano[0].acao, motivo: x.analise.plano[0].motivo, impacto: x.analise.plano[0].impacto }; })() : null,
  };
  return { periodo: { dias: periodo, de: addDias(fim, -(periodo - 1)), ate: fim }, painel, respostas, anuncios: lista };
}

module.exports = { analisarCarteira, metricas, referencias, analisarAnuncio, faixa, LIM, CATEGORIAS, FASE_NOME, addDias };
