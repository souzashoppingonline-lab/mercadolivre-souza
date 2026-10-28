// Nome dos estágios do Rankeamento no Telegram — mesmos das abas de
// pages/rankeamento.html. Usado por ranking.js e rankingVendasResumo.js.
const FASE_LABEL = {
  rankeando: '🚀 Em rankeamento', ranqueado: '🛡️ Ranqueado', monitoramento: '👁️ Monitoramento',
  recuperacao: '❤️‍🩹 Recuperação', catalogo: '🏆 Catálogo (Buy Box)',
};
const faseLabel = (f) => FASE_LABEL[f || 'rankeando'] || String(f);
module.exports = { FASE_LABEL, faseLabel };
