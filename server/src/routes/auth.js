// OAuth flow — each store owner visits /auth/login once to authorize.
// Tokens are stored in the `stores` table and refreshed automatically by the worker.
const express = require('express');
const fetch = require('node-fetch');
const pool = require('../db/pool');
const env = require('../config/env');

const router = express.Router();

const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

// Step 1 — redirect to Mercado Livre authorization page
router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.ml.clientId,
    redirect_uri: env.ml.redirectUri,
  });
  res.redirect(`${ML_AUTH_URL}?${params}`);
});

// Step 2 — ML redirects back here with ?code=...
// Route matches both /auth/callback and /ml/callback (configured in ML app)
router.get(['/callback', '/ml/callback'], async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`Autorização negada: ${error || 'sem código'}`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(ML_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.ml.clientId,
        client_secret: env.ml.clientSecret,
        code,
        redirect_uri: env.ml.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const tokens = await tokenRes.json();
    // tokens: { access_token, refresh_token, expires_in, user_id, ... }

    // Fetch store info
    const userRes = await fetch(`https://api.mercadolibre.com/users/${tokens.user_id}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await pool.query(
      `INSERT INTO stores (id, nickname, access_token, refresh_token, token_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at = now()`,
      [tokens.user_id, user.nickname, tokens.access_token, tokens.refresh_token, expiresAt]
    );

    console.log(`[auth] store autorizada: ${user.nickname} (${tokens.user_id})`);

    res.send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>body{font-family:sans-serif;background:#1a1d23;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px}</style>
      </head><body>
      <h2 style="color:#FFE600">✅ Loja autorizada com sucesso!</h2>
      <p><strong>${user.nickname}</strong> (ID: ${tokens.user_id})</p>
      <p>Você pode fechar esta aba e voltar ao dashboard.</p>
      <a href="/" style="color:#FFE600">← Ir para o Dashboard</a>
      </body></html>
    `);
  } catch (err) {
    console.error('[auth] callback error', err);
    res.status(500).send(`Erro ao autorizar: ${err.message}`);
  }
});

// Refresh a store token (called by worker before each ML API call)
async function refreshToken(storeId) {
  const { rows } = await pool.query(
    'SELECT refresh_token FROM stores WHERE id = $1', [storeId]
  );
  if (!rows.length) throw new Error(`store ${storeId} not found`);

  const res = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.ml.clientId,
      client_secret: env.ml.clientSecret,
      refresh_token: rows[0].refresh_token,
    }),
  });

  if (!res.ok) throw new Error(`Refresh failed: HTTP ${res.status}`);
  const tokens = await res.json();

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await pool.query(
    `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now() WHERE id=$1`,
    [storeId, tokens.access_token, tokens.refresh_token, expiresAt]
  );

  return tokens.access_token;
}

module.exports = router;
module.exports.refreshToken = refreshToken;
