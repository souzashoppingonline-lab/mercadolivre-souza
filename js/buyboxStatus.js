// Status de Buy Box (catálogo) — regra ÚNICA usada pela tela de Rankeamento
// (card/filtro do estágio Catálogo) e pelo relatório de Buy Box no Telegram
// (worker.js → server/src/buyboxRelatorio.js). Navegador (window.BuyboxStatus)
// e Node. Ver .claude/business-rules.md ("Monitor de Buy-Box").
//
// Ganhando = winner_item_id === o próprio anúncio (nunca pela string crua de
// status — só 'competing' foi confirmado ao vivo); 'sharing_first_place' é a
// única outra string em que se confia (enum oficial informado pelo usuário).
(function () {
  function classificar({ calculado_em, winner_item_id, item_id, status }) {
    if (!calculado_em) return { chave: 'aguardando', label: 'Aguardando 1ª sincronização', cor: '#8b949e', ico: '⏳' };
    if (winner_item_id && winner_item_id === item_id) return { chave: 'ganhando', label: 'GANHANDO', cor: '#3fb950', ico: '🏆' };
    if (status === 'sharing_first_place') return { chave: 'compartilhando', label: 'COMPARTILHANDO O 1º LUGAR', cor: '#f0883e', ico: '🤝' };
    if (winner_item_id) return { chave: 'perdendo', label: 'PERDENDO', cor: '#f85149', ico: '📉' };
    return { chave: 'sem_concorrencia', label: 'Sem concorrência detectada', cor: '#8b949e', ico: '—' };
  }
  const API = { classificar };
  if (typeof window !== 'undefined') window.BuyboxStatus = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
