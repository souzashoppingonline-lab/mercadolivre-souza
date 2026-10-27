// Registro de TODA mensagem do Telegram pra "Tela Telegram" (TV). Chamado
// logo depois de cada envio que deu certo (notify.js tgNotify/tgNotifyForce e
// os poucos envios diretos: resposta do bot, confirmação de pergunta, tarefa
// apagada, teste) e quando chega comando no bot (direcao='entrada').
// Grava em telegram_mensagens (migrate-v120) e avisa as telas abertas pelo
// WebSocket SÓ com o id (`telegram_mensagem`) — o texto (que pode ter dado
// financeiro) não vai pelo /ws, que é público; a tela busca pela API com login
// ou token. Nunca lança: registrar não pode atrapalhar o envio.
const pool = require('./db/pool');

async function registrarMensagem({ topico = null, texto, html = true, direcao = 'saida', autor = null }) {
  try {
    if (!texto) return null;
    const { rows } = await pool.query(
      `INSERT INTO telegram_mensagens (topico, texto, html, direcao, autor) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [topico, String(texto).slice(0, 8000), !!html, direcao === 'entrada' ? 'entrada' : 'saida', autor]
    );
    try { await require('./ws/hub').publish('telegram_mensagem', { id: rows[0].id }); } catch (_) { /* tela pega no próximo poll */ }
    return rows[0].id;
  } catch (e) {
    console.error('[telegram-log] não registrei a mensagem:', e.message);
    return null;
  }
}

module.exports = { registrarMensagem };
