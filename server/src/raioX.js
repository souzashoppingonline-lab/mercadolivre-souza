// Raio-X do anúncio (v189) — contas puras da aba aberta ao clicar na foto da
// "Nova venda!" na Tela Telegram (pages/anuncio-raio-x.html). Sem banco aqui
// (testável com node --test); a série diária vem de analistaEcom.getHistoricoItem.
// Detalhes e regras: .claude/business-rules.md, "Raio-X do anúncio".
//
// `dias` = série diária em ordem crescente, ÚLTIMO elemento = hoje (parcial):
//   [{ data:'AAAA-MM-DD', pedidos, unidades, visitas }]
// - Vendas/visitas de cada janela INCLUEM hoje (o que o vendedor espera ver).
// - Conversão, médias, tendência e previsão usam só DIAS FECHADOS (até ontem):
//   as visitas de hoje só entram no sync do dia seguinte, e o dia de hoje
//   ainda está pela metade — incluí-lo distorceria tudo.

const JANELAS_RAIO_X = [3, 5, 7, 15, 21, 30];
const DIAS_SERIE_RAIO_X = 61;          // 60 dias fechados + hoje (v189.2: comparação com o mês anterior)
const DIAS_GRAFICO = 31;               // o gráfico mostra só os últimos 30 dias + hoje
const QUEDA_ALERTA_PCT = -30;          // faixa vermelha: unidades 7d × 7d anteriores ≤ −30%…
const QUEDA_MIN_UNIDADES = 7;          // …e vendia bem (≥ 7 un. nos 7 dias anteriores = 1/dia)
const QUEDA_VISITAS_PCT = -20;         // motivo "menos visitas" quando as visitas caíram ≥ 20%
const PESO_RECENTE = 0.6;              // previsão: 60% média de 7 dias + 40% média de 30 dias
const TENDENCIA_ESTAVEL_PCT = 10;      // |variação| < 10% → "estável"
const REPOR_URGENTE_DIAS = 7;          // cobertura < 7 dias → vermelho
const REPOR_ATENCAO_DIAS = 15;         // cobertura < 15 dias → amarelo

const soma = (lista, campo) => lista.reduce((s, d) => s + (Number(d[campo]) || 0), 0);
const r1 = (n) => Math.round(n * 10) / 10;

// Variação entre dois períodos do mesmo tamanho (unidades ou visitas).
function tendencia(atual, anterior) {
  if (!anterior && !atual) return { atual, anterior, pct: null, direcao: 'sem_dados' };
  if (!anterior) return { atual, anterior, pct: null, direcao: 'subindo' };   // não vendia, passou a vender
  const pct = r1(((atual - anterior) / anterior) * 100);
  const direcao = Math.abs(pct) < TENDENCIA_ESTAVEL_PCT ? 'estavel' : pct > 0 ? 'subindo' : 'caindo';
  return { atual, anterior, pct, direcao };
}

function resumirRaioX({ dias = [], estoque = null, hoje = new Date(), janelas = JANELAS_RAIO_X } = {}) {
  const fechados = dias.slice(0, -1);                 // até ontem
  const ultimosFechados = (n) => fechados.slice(-n);

  const porJanela = janelas.map((n) => {
    const comHoje = dias.slice(-n);
    const conv = ultimosFechados(n);
    const visitasConv = soma(conv, 'visitas');
    return {
      dias: n,
      pedidos: soma(comHoje, 'pedidos'),
      unidades: soma(comHoje, 'unidades'),
      visitas: soma(comHoje, 'visitas'),
      conversao: visitasConv > 0 ? r1((soma(conv, 'pedidos') / visitasConv) * 100) : null,
      media_dia: r1(soma(conv, 'unidades') / Math.max(1, Math.min(n, conv.length))),
    };
  });

  const periodo = (n, desloc) => fechados.slice(fechados.length - n - desloc, fechados.length - desloc);
  const tend7 = tendencia(soma(periodo(7, 0), 'unidades'), soma(periodo(7, 7), 'unidades'));
  const tend15 = tendencia(soma(periodo(15, 0), 'unidades'), soma(periodo(15, 15), 'unidades'));
  const tendVisitas7 = tendencia(soma(periodo(7, 0), 'visitas'), soma(periodo(7, 7), 'visitas'));

  const media7 = soma(ultimosFechados(7), 'unidades') / Math.max(1, Math.min(7, fechados.length));
  const media30 = soma(ultimosFechados(30), 'unidades') / Math.max(1, Math.min(30, fechados.length));
  const porDia = PESO_RECENTE * media7 + (1 - PESO_RECENTE) * media30;
  const previsao = { por_dia: r1(porDia), d7: Math.round(porDia * 7), d15: Math.round(porDia * 15), d30: Math.round(porDia * 30) };

  let cobertura = null;
  const est = Number(estoque);
  if (estoque != null && Number.isFinite(est)) {
    const diasCob = porDia > 0 ? est / porDia : null;
    const acaba = diasCob != null ? new Date(hoje.getTime() + diasCob * 86400000) : null;
    cobertura = {
      estoque: est,
      dias: diasCob == null ? null : r1(diasCob),
      acaba_em: acaba ? acaba.toISOString().slice(0, 10) : null,
      nivel: est <= 0 ? 'sem_estoque' : diasCob == null ? 'parado'
        : diasCob < REPOR_URGENTE_DIAS ? 'urgente' : diasCob < REPOR_ATENCAO_DIAS ? 'atencao' : 'ok',
    };
  }

  return { janelas: porJanela, tendencia: { unidades_7: tend7, unidades_15: tend15, visitas_7: tendVisitas7 },
    previsao, cobertura, frases: frasesResumo({ tend7, tendVisitas7, cobertura, previsao }) };
}

// Leitura em português do que os números dizem (a página mostra no topo).
const pctBR = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
function frasesResumo({ tend7, tendVisitas7, cobertura, previsao }) {
  const f = [];
  if (tend7.direcao === 'subindo') f.push(tend7.pct == null ? 'Voltou a vender nesta semana.' : `Vendas subindo ${pctBR(tend7.pct)}% na última semana.`);
  else if (tend7.direcao === 'caindo') f.push(`Vendas caindo ${pctBR(Math.abs(tend7.pct))}% na última semana.`);
  else if (tend7.direcao === 'estavel') f.push('Vendas estáveis na última semana.');
  else f.push('Sem vendas nas últimas 2 semanas.');
  if (tend7.direcao === 'caindo' && tendVisitas7.direcao === 'caindo') f.push('As visitas também caíram — o anúncio está aparecendo menos.');
  else if (tend7.direcao === 'caindo' && tendVisitas7.direcao !== 'caindo') f.push('As visitas não caíram — quem entra está comprando menos (preço, concorrente ou estoque).');
  if (cobertura) {
    if (cobertura.nivel === 'sem_estoque') f.push('Sem estoque — repor agora.');
    else if (cobertura.nivel === 'urgente') f.push(`Estoque acaba em ~${Math.round(cobertura.dias)} dias — repor já.`);
    else if (cobertura.nivel === 'atencao') f.push(`Estoque dá para ~${Math.round(cobertura.dias)} dias — programar reposição.`);
    else if (cobertura.nivel === 'ok') f.push(`Estoque dá para ~${Math.round(cobertura.dias)} dias.`);
  }
  if (previsao.d7 > 0) f.push(`Previsão: ~${previsao.d7} unidades nos próximos 7 dias.`);
  return f;
}

// ── Blocos extras (v189.1): qualidade, concorrência, devoluções ──────────────

// O que falta arrumar no anúncio, a partir da linha de item_seo_score (mesmos
// limiares de seoScore.js — fonte única). Lista vazia = nada pendente.
function pendenciasSeo(row) {
  if (!row) return null;
  const { THRESHOLDS } = require('./seoScore');
  const p = [];
  const fotos = Number(row.pictures_count) || 0;
  if (fotos < THRESHOLDS.photosForFullScore) p.push(`Só ${fotos} foto(s) — o ideal é ${THRESHOLDS.photosForFullScore} ou mais`);
  if (!row.has_video) p.push('Sem vídeo (clip)');
  const desc = Number(row.description_word_count) || 0;
  if (desc < THRESHOLDS.descriptionWordsForFullScore) p.push(`Descrição curta (${desc} palavras — ideal ${THRESHOLDS.descriptionWordsForFullScore}+)`);
  const tit = Number(row.title_length) || 0;
  if (tit && tit < THRESHOLDS.titleMaxChars * 0.7) p.push(`Título curto (${tit} de ${THRESHOLDS.titleMaxChars} caracteres)`);
  if (row.has_gtin === false) p.push('Sem código de barras (GTIN)');
  if (row.has_brand === false) p.push('Sem marca preenchida');
  if (row.has_model === false) p.push('Sem modelo preenchido');
  const faltam = Array.isArray(row.missing_required_attrs) ? row.missing_required_attrs : [];
  if (faltam.length) p.push(`Atributos obrigatórios faltando: ${faltam.slice(0, 6).join(', ')}${faltam.length > 6 ? '…' : ''}`);
  return { score: row.score == null ? null : Math.round(Number(row.score)), pendencias: p, calculado_em: row.calculated_at || null };
}

// Buy box (catalog_competition): ganhando = winner_item_id é o próprio anúncio
// (mesma regra do Monitor de Buy-Box — ver decisions.md).
function resumoBuybox(row, itemId) {
  if (!row) return null;
  const ganhando = row.winner_item_id ? String(row.winner_item_id) === String(itemId) : null;
  return {
    ganhando, meu_preco: row.current_price == null ? null : Number(row.current_price),
    preco_vencedor: row.winner_price == null ? null : Number(row.winner_price),
    preco_para_ganhar: row.price_to_win == null ? null : Number(row.price_to_win),
    falta: Array.isArray(row.boosts_missing) ? row.boosts_missing : [],
    calculado_em: row.calculated_at || null,
  };
}

// Devoluções do anúncio na janela: total, taxa sobre os pedidos e motivos mais comuns.
function resumoDevolucoes({ devolucoes = [], pedidos = 0, dias = 90 } = {}) {
  const motivos = new Map();
  for (const d of devolucoes) { const m = String(d.reason || 'Sem motivo informado').trim(); motivos.set(m, (motivos.get(m) || 0) + 1); }
  return {
    dias, total: devolucoes.length, pedidos,
    taxa: pedidos > 0 ? r1((devolucoes.length / pedidos) * 100) : null,
    motivos: [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([motivo, qtd]) => ({ motivo, qtd })),
  };
}

// ── v189.2: mês passado, marcadores de preço/promoção, quando vende, faixa de queda ──

// Últimos 30 dias fechados × os 30 anteriores (precisa da série de 61 dias).
function comparacaoMes(dias = []) {
  const fechados = dias.slice(0, -1);
  if (fechados.length < 60) return null;
  const bloco = (lista) => {
    const visitas = soma(lista, 'visitas'), pedidos = soma(lista, 'pedidos');
    return { pedidos, unidades: soma(lista, 'unidades'), visitas, conversao: visitas > 0 ? r1((pedidos / visitas) * 100) : null };
  };
  const atual = bloco(fechados.slice(-30)), anterior = bloco(fechados.slice(-60, -30));
  const varPct = (a, b) => (b > 0 ? r1(((a - b) / b) * 100) : null);
  return { atual, anterior, var: { pedidos: varPct(atual.pedidos, anterior.pedidos), unidades: varPct(atual.unidades, anterior.unidades),
    visitas: varPct(atual.visitas, anterior.visitas),
    conversao_pp: atual.conversao != null && anterior.conversao != null ? r1(atual.conversao - anterior.conversao) : null } };
}

// Marcadores do gráfico: mudanças de preço (price_history) e entrada/saída de
// promoção (promotions, mesma regra de transição do handleOffer — business-rules.md).
function eventosPreco({ precos = [], promocoes = [] } = {}) {
  const dia = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const ev = [];
  for (const p of precos) {
    if (p.old_price == null || p.new_price == null || Number(p.old_price) === Number(p.new_price)) continue;
    const sobe = Number(p.new_price) > Number(p.old_price);
    ev.push({ data: dia(p.changed_at), tipo: sobe ? 'preco_sobe' : 'preco_desce', texto: `Preço ${sobe ? 'subiu' : 'baixou'}: ${brl(p.old_price)} → ${brl(p.new_price)}` });
  }
  for (const p of promocoes) {
    if (p.status === 'active' && p.previous_status !== 'active') {
      ev.push({ data: dia(p.changed_at), tipo: 'promo_entra', texto: `Entrou em promoção${p.promo_price != null ? ` (${brl(p.promo_price)}${p.discount_pct ? `, −${Math.round(Number(p.discount_pct))}%` : ''})` : ''}` });
    } else if (p.previous_status === 'active' && p.status !== 'active') {
      ev.push({ data: dia(p.changed_at), tipo: 'promo_sai', texto: 'Saiu da promoção' });
    }
  }
  return ev.sort((a, b) => a.data.localeCompare(b.data));
}

// Quando vende: linhas {dow 0=dom..6, hora 0..23, unidades} (fuso SP) → totais por dia da semana e por hora.
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function quandoVende(linhas = [], dias = 90) {
  const semana = Array(7).fill(0), horas = Array(24).fill(0);
  for (const l of linhas) {
    const u = Number(l.unidades) || 0;
    if (l.dow >= 0 && l.dow < 7) semana[l.dow] += u;
    if (l.hora >= 0 && l.hora < 24) horas[l.hora] += u;
  }
  const total = semana.reduce((s, n) => s + n, 0);
  if (!total) return { dias, total: 0, semana, horas, melhor_dia: null, melhor_faixa: null };
  const iDia = semana.indexOf(Math.max(...semana));
  // melhor faixa de 3 horas seguidas (lê melhor que 1 hora solta)
  let melhorIni = 0, melhorSoma = -1;
  for (let h = 0; h < 24; h++) { const s3 = horas[h] + horas[(h + 1) % 24] + horas[(h + 2) % 24]; if (s3 > melhorSoma) { melhorSoma = s3; melhorIni = h; } }
  return { dias, total, semana, horas, melhor_dia: { nome: DIAS_SEMANA[iDia], pct: Math.round((semana[iDia] / total) * 100) },
    melhor_faixa: { de: melhorIni, ate: (melhorIni + 3) % 24, pct: Math.round((melhorSoma / total) * 100) } };
}

// Faixa vermelha de queda no topo do raio-X (pedido do usuário: o aviso fica na aba, não no Telegram).
function alertaQueda({ tendencia: t = {}, buybox = null, cobertura = null } = {}) {
  const u = t.unidades_7, v = t.visitas_7;
  if (!u || u.direcao !== 'caindo' || u.pct > QUEDA_ALERTA_PCT || u.anterior < QUEDA_MIN_UNIDADES) return null;
  const motivos = [];
  if (v && v.pct != null && v.pct <= QUEDA_VISITAS_PCT) motivos.push(`Menos visitas (${String(v.pct).replace('.', ',')}%) — o anúncio está aparecendo menos`);
  if (buybox && buybox.ganhando === false) motivos.push(`Perdeu o buy box${buybox.preco_vencedor != null ? ` — quem ganha cobra ${Number(buybox.preco_vencedor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : ''}`);
  if (cobertura && (cobertura.nivel === 'urgente' || cobertura.nivel === 'sem_estoque')) motivos.push(cobertura.nivel === 'sem_estoque' ? 'Sem estoque' : 'Estoque acabando');
  if (!motivos.length) motivos.push('As visitas se mantiveram — quem entra está comprando menos (preço, concorrente, frete ou anúncio)');
  return { pct: u.pct, atual: u.atual, anterior: u.anterior, motivos };
}

// ── v189.3: margem de contribuição das vendas do anúncio ──────────────────
// `linhas` = linhas de VENDA_DETALHE_SELECT já passadas por calcularMargemLinha
// (vendaMargem.js — a MESMA fórmula do Resumo por Venda; nunca uma 2ª fórmula).
// Mesmas colunas do card do Resumo por Venda: venda, frete vend., tarifa, custo, imposto, margem e MC%.
function resumoMargem(linhas = [], { agora = new Date(), janelas = [7, 30], ultimas = 10 } = {}) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const bloco = (lista) => {
    const s = (f) => lista.reduce((a, l) => a + (Number(f(l)) || 0), 0);
    const faturamento = s((l) => l.faturamento), margem = s((l) => l.margem);
    return {
      vendas: lista.length, unidades: s((l) => l.quantity), faturamento: r2(faturamento), custo: r2(s((l) => l.custo)),
      imposto: r2(s((l) => l.imposto)), tarifa: r2(s((l) => l.tarifa)), frete_vend: r2(s((l) => l.freteVend)), frete_comprador: r2(s((l) => l.frete_comprador)),
      margem: r2(margem), mc_pct: faturamento > 0 ? r1((margem / faturamento) * 100) : null,
      confirmadas: lista.filter((l) => l.fonte_taxa && l.fonte_taxa !== 'pedido').length,
    };
  };
  const porJanela = janelas.map((n) => ({ dias: n, ...bloco(linhas.filter((l) => agora - new Date(l.date_created) < n * 86400000)) }));
  const ord = [...linhas].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  return {
    janelas: porJanela,
    custo_ausente: linhas.some((l) => l.custo_ausente),
    imposto_pct: linhas.length ? Number(linhas[0].imposto_pct) || 0 : null,
    ultimas: ord.slice(0, ultimas).map((l) => ({
      pedido: l.ml_id, data: l.date_created, unidades: Number(l.quantity) || 0, faturamento: r2(Number(l.faturamento) || 0),
      custo: r2(Number(l.custo) || 0), imposto: r2(Number(l.imposto) || 0), tarifa: r2(Number(l.tarifa) || 0),
      frete_vend: r2(Number(l.freteVend) || 0), frete_comprador: r2(Number(l.frete_comprador) || 0), margem: r2(Number(l.margem) || 0),
      mc_pct: l.mc_pct, confirmada: !!(l.fonte_taxa && l.fonte_taxa !== 'pedido'), logistica: l.frete_tipo || null,
    })),
  };
}

module.exports = { resumirRaioX, tendencia, pendenciasSeo, resumoBuybox, resumoDevolucoes, resumoMargem,
  comparacaoMes, eventosPreco, quandoVende, alertaQueda, DIAS_GRAFICO, QUEDA_ALERTA_PCT, QUEDA_MIN_UNIDADES, QUEDA_VISITAS_PCT, JANELAS_RAIO_X, DIAS_SERIE_RAIO_X, PESO_RECENTE,
  TENDENCIA_ESTAVEL_PCT, REPOR_URGENTE_DIAS, REPOR_ATENCAO_DIAS };
