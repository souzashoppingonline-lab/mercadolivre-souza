// Login de acesso restrito (staff) — três papéis: 'admin' (acesso total,
// mesmo comportamento que o sistema sempre teve), 'embalagem' (só bipagem
// + vídeo de conferência) e 'shopee-demo' (só dashboard-shopee.html + API
// Shopee — conta pra revisor externo, ex. Shopee Open Platform, nunca vê
// dado do Mercado Livre/financeiro/embalagem). Ver .claude/auth-staff.md
// para a arquitetura completa e o botão de emergência (STAFF_AUTH_ENABLED=false).
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const pool = require('../db/pool');

const router = express.Router();
const COOKIE_NAME = 'staff_session';

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'usuário e senha são obrigatórios' });

    const { rows } = await pool.query(
      `SELECT id, username, password_hash, role FROM staff_users WHERE username = $1`,
      [username]
    );
    const user = rows[0];
    const ok = user && await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'usuário ou senha inválidos' });

    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      env.staffAuth.jwtSecret,
      { expiresIn: `${env.staffAuth.sessionDays}d` }
    );
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true, // domínio sempre HTTPS em produção (Let's Encrypt, ver deployment.md)
      sameSite: 'lax',
      maxAge: env.staffAuth.sessionDays * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (e) {
    console.error('[auth/staff] POST /login', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'não autenticado' });
  try {
    const payload = jwt.verify(token, env.staffAuth.jwtSecret);
    res.json({ username: payload.username, role: payload.role });
  } catch (e) {
    res.status(401).json({ error: 'sessão inválida ou expirada' });
  }
});

// ── Middleware global — protege API + páginas estáticas ────────────────
// Caminhos que NUNCA passam por este gate, mesmo com o gate ligado: fluxos
// que não são iniciados por uma sessão de staff logada (webhooks do ML,
// callbacks de OAuth do ML/Shopee, o próprio login) e o WebSocket (eventos
// de notificação leves, não dados completos — ver known-bugs.md/decisions.md
// se isso precisar mudar no futuro).
const PUBLIC_PREFIXES = ['/webhooks', '/auth', '/ml', '/health', '/ws', '/pages/login.html', '/favicon.ico'];
// Além de /api/embalagem/*, o papel 'embalagem' também precisa disso:
const EMBALAGEM_EXTRA_API = ['/api/lojas']; // dropdown de loja na aba Conferência do Dia
const EMBALAGEM_EXTRA_PAGES = ['/pages/embalagem.html'];
const EMBALAGEM_ASSET_PREFIXES = ['/css/', '/js/', '/favicon'];

// Papel 'shopee-demo' — só a página/API do dashboard Shopee (ver
// pages/dashboard-shopee.html, routes/shopee.js). Usado por um revisor
// externo (ex. Shopee Open Platform) que não deve ver nenhum outro dado.
const SHOPEE_DEMO_PAGES = ['/pages/dashboard-shopee.html', '/pages/shopee-vendas.html', '/pages/shopee-anuncios.html', '/pages/shopee-financeiro.html', '/pages/shopee-chat.html', '/pages/shopee-lojas.html', '/pages/shopee-precos-estoque.html', '/pages/shopee-precificador.html', '/pages/shopee-promocoes.html', '/pages/shopee-problemas.html', '/pages/shopee-performance.html', '/pages/shopee-ia-socio.html'];
const SHOPEE_DEMO_ASSET_PREFIXES = ['/css/', '/js/', '/favicon'];

function isPublicPath(p) {
  return PUBLIC_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/'));
}

function isEmbalagemAllowed(p) {
  if (p.startsWith('/api/embalagem')) return true;
  if (EMBALAGEM_EXTRA_API.includes(p)) return true;
  if (EMBALAGEM_EXTRA_PAGES.includes(p)) return true;
  if (EMBALAGEM_ASSET_PREFIXES.some(prefix => p.startsWith(prefix))) return true;
  return false;
}

function isShopeeDemoAllowed(p) {
  if (p.startsWith('/api/shopee')) return true;
  if (SHOPEE_DEMO_PAGES.includes(p)) return true;
  if (SHOPEE_DEMO_ASSET_PREFIXES.some(prefix => p.startsWith(prefix))) return true;
  return false;
}

function requireStaffAuth(req, res, next) {
  if (!env.staffAuth.enabled) return next(); // botão de emergência — gate desligado
  if (isPublicPath(req.path)) return next();

  const isApiOrWebhook = req.path.startsWith('/api/');
  const token = req.cookies?.[COOKIE_NAME];
  let payload = null;
  if (token) {
    try { payload = jwt.verify(token, env.staffAuth.jwtSecret); } catch (e) { payload = null; }
  }

  if (!payload) {
    if (isApiOrWebhook) return res.status(401).json({ error: 'não autenticado' });
    return res.redirect('/pages/login.html');
  }

  if (payload.role === 'embalagem' && !isEmbalagemAllowed(req.path)) {
    if (isApiOrWebhook) return res.status(403).json({ error: 'acesso restrito — esse usuário só tem permissão pra Embalagem' });
    return res.redirect('/pages/embalagem.html');
  }

  if (payload.role === 'shopee-demo' && !isShopeeDemoAllowed(req.path)) {
    if (isApiOrWebhook) return res.status(403).json({ error: 'acesso restrito — esse usuário só tem permissão pro dashboard Shopee' });
    return res.redirect('/pages/dashboard-shopee.html');
  }

  req.staffUser = payload;
  next();
}

module.exports = { router, requireStaffAuth };
