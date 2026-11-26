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
const DIAS_SERIE_RAIO_X = 31;          // 30 dias fechados + hoje
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

module.exports = { resumirRaioX, tendencia, pendenciasSeo, resumoBuybox, resumoDevolucoes, JANELAS_RAIO_X, DIAS_SERIE_RAIO_X, PESO_RECENTE,
  TENDENCIA_ESTAVEL_PCT, REPOR_URGENTE_DIAS, REPOR_ATENCAO_DIAS };
