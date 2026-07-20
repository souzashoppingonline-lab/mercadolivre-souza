// Telegram notification helpers — compartilhado entre worker.js (pipeline ML) e
// marketplaceEventWorker.js (Amazon/Shopee), pra qualquer pipeline poder
// notificar sem duplicar a lógica de token/chat/silêncio/throttle.
//
// `tgNotify` respeita janela de silêncio + intervalo mínimo por tópico
// (config em app_config); `tgNotifyForce` ignora silêncio/throttle. Config lida
// de app_config com fallback pros envs TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.
const pool = require('./db/pool');

const _tgLastSent = {};

async function tgNotifyForce(topic, text) {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [['telegram_bot_token', 'telegram_chat_id', topic]]
    );
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const token = cfg.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = cfg.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    if (cfg[topic] === 'false') return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[notify] tgNotifyForce error:', e.message); }
}

async function tgNotify(topic, text) {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [['telegram_bot_token', 'telegram_chat_id', topic, 'tg_interval', 'silence_start', 'silence_end']]
    );
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const token = cfg.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = cfg.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    if (cfg[topic] === 'false' || cfg[topic] === false) return;

    // Janela de silêncio
    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5);
    const ss = cfg.silence_start || '22:00';
    const se = cfg.silence_end || '07:00';
    const inSilence = ss > se ? (hhmm >= ss || hhmm < se) : (hhmm >= ss && hhmm < se);
    if (inSilence) return;

    // Throttle por intervalo mínimo
    const interval = Number(cfg.tg_interval || 0) * 60 * 1000;
    if (interval > 0) {
      const last = _tgLastSent[topic] || 0;
      if (Date.now() - last < interval) return;
    }
    _tgLastSent[topic] = Date.now();

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const j = await r.json();
    return j?.result?.message_id || null;
  } catch (e) {
    console.error('[notify] tgNotify error:', e.message);
    return null;
  }
}

module.exports = { tgNotify, tgNotifyForce };
