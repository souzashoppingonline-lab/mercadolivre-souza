// Tela Telegram (TV) — mensagens copiadas em telegram_mensagens
// (telegramLog.js). Duas portas pro mesmo dado:
//  • /api/telegram-tela          → com login (gate normal de /api)
//  • /api/publico/telegram-tela  → link da TV, com ?token= (app_config
//    telegram_tela_token, 32 hex). A TV não precisa de usuário/senha nem cai
//    a sessão. "Gerar novo link" troca o token e o link antigo para de valer.
// GET ?depois_id=N → só as mais novas (a tela pergunta a cada 15s e quando o
// WebSocket avisa `telegram_mensagem`); sem depois_id → as últimas `limit`.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');

const router = express.Router();
const publicRouter = express.Router();

async function listar(req, res) {
  try {
    const depois = Number(req.query.depois_id) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
    const { rows } = depois
      ? await pool.query(`SELECT id, topico, texto, html, direcao, autor, criado_em FROM telegram_mensagens WHERE id > $1 ORDER BY id ASC LIMIT $2`, [depois, limit])
      : await pool.query(`SELECT * FROM (SELECT id, topico, texto, html, direcao, autor, criado_em FROM telegram_mensagens ORDER BY id DESC LIMIT $1) x ORDER BY id ASC`, [limit]);
    const { rows: h } = await pool.query(`SELECT COUNT(*)::int AS n FROM telegram_mensagens WHERE criado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`);
    res.json({ mensagens: rows, hoje: h[0].n });
  } catch (e) {
    console.error('[api/telegram-tela]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function tokenTv(novo) {
  if (!novo) {
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key = 'telegram_tela_token'`);
    if (rows[0] && /^[0-9a-f]{32}$/.test(rows[0].value)) return rows[0].value;
  }
  const t = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('telegram_tela_token', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [t]);
  return t;
}

router.get('/', listar);
// Link da TV (cria o token na 1ª vez) / gerar um novo (revoga o anterior).
router.get('/link-tv', async (req, res) => {
  try { res.json({ token: await tokenTv(false) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/link-tv/novo', async (req, res) => {
  try { res.json({ token: await tokenTv(true) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

publicRouter.get('/', async (req, res, next) => {
  try {
    const t = String(req.query.token || '');
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key = 'telegram_tela_token'`);
    const certo = rows[0] && rows[0].value;
    if (!/^[0-9a-f]{32}$/.test(t) || !certo || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(certo))) {
      return res.status(403).json({ error: 'link da TV inválido — gere um novo na Tela Telegram' });
    }
    return listar(req, res, next);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, publicRouter };
