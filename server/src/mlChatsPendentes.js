// Chats pós-venda do Mercado Livre sem leitura — fonte = API do ML (pedido do usuário:
// o contador local `messages.unread` acumulava conversa já respondida). PURO, testado
// em test/mlChatsPendentes.test.js. Quem chama: worker.js syncChatsMlPendentes (10 min
// + boot) → grava o resultado em Redis (CHAVE); routes/telegramTela.js lê pro aviso fixo.

const CHAVE = 'ml:chats:pendentes';
const TTL_S = 3600; // sem conferência por 1h → aviso não mostra chat ML (melhor nada que número velho)

// GET /messages/unread?role=seller&tag=post_sale. Formato documentado:
// { results: [{ resource: '/packs/<pack_id>/sellers/<seller_id>', count: N }] }.
// Aceita também array solto e itens com pack_id/unread. Formato desconhecido → null.
function lerNaoLidas(r) {
  const arr = Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : null);
  if (!arr) return null;
  return arr.map((x) => {
    const pack = (String(x.resource || '').match(/packs\/(\d+)/) || [])[1] || (x.pack_id != null ? String(x.pack_id) : null);
    return { pack, n: Number(x.count ?? x.unread ?? x.unread_count ?? 1) || 1 };
  }).filter((x) => x.pack);
}

module.exports = { CHAVE, TTL_S, lerNaoLidas };
