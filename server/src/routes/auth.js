// OAuth flow — each store owner visits /auth/login once to authorize.
// Tokens are stored in the `stores` table and refreshed automatically by the worker.
const express = require('express');
const fetch = require('node-fetch');
const pool = require('../db/pool');
const env = require('../config/env');

const router = express.Router();

const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

const DIAG_STYLE = `body{font-family:sans-serif;background:#1a1d23;color:#f0f0f0;max-width:680px;margin:40px auto;padding:24px}
  h2{color:#FFE600;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:16px 0}
  td{padding:10px 12px;border:1px solid #2a2d35;vertical-align:top}td:first-child{width:140px;color:#888;font-size:13px}
  code{background:#2a2d35;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
  .ok{color:#4CAF50}.err{color:#f44336}.warn{color:#FF9800}
  a{color:#FFE600;text-decoration:none}p{line-height:1.6;color:#aaa}`;

// Diagnóstico OAuth — mostra client_id e redirect_uri sem expor o secret
router.get('/config', (req, res) => {
  const cid = env.ml.clientId;
  const ruri = env.ml.redirectUri;
  const csec = env.ml.clientSecret;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Config OAuth</title>
    <style>${DIAG_STYLE}</style></head><body>
    <h2>Configuração OAuth — Mercado Livre</h2>
    <p>Compare estes valores com o cadastrado em <a href="https://developers.mercadolivre.com.br" target="_blank">developers.mercadolivre.com.br</a> → Aplicações → sua app.</p>
    <table>
      <tr><td>client_id</td><td>${cid ? `<code>${cid}</code>` : '<span class="err">❌ NÃO CONFIGURADO (ML_CLIENT_ID)</span>'}</td></tr>
      <tr><td>client_secret</td><td>${csec ? '<span class="ok">✓ configurado (oculto)</span>' : '<span class="err">❌ NÃO CONFIGURADO (ML_CLIENT_SECRET)</span>'}</td></tr>
      <tr><td>redirect_uri</td><td>${ruri ? `<code>${ruri}</code>` : '<span class="err">❌ NÃO CONFIGURADO (ML_REDIRECT_URI)</span>'}</td></tr>
    </table>
    <p><strong>O redirect_uri acima deve estar cadastrado EXATAMENTE</strong> em "URLs de redirecionamento" no painel do app ML. Qualquer diferença (http vs https, barra no final, porta) causa o erro "não foi possível conectar".</p>
    <p><a href="/auth/login">→ Tentar autorizar uma conta</a></p>
    </body></html>`);
});

// Step 1 — redirect to Mercado Livre authorization page
// Optional ?store_id=X uses that store's own ml_client_id if configured
router.get('/login', async (req, res) => {
  let clientId = env.ml.clientId;
  const storeId = req.query.store_id;
  if (storeId) {
    const { rows } = await pool.query('SELECT ml_client_id FROM stores WHERE id=$1', [storeId]);
    if (rows[0]?.ml_client_id) clientId = rows[0].ml_client_id;
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: env.ml.redirectUri,
    state: storeId || '',
  });
  res.redirect(`${ML_AUTH_URL}?${params}`);
});

// Step 2 — ML redirects back here with ?code=...
// Route matches both /auth/callback and /ml/callback (configured in ML app)
router.get(['/callback', '/ml/callback'], async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro OAuth</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>❌ Autorização negada pelo Mercado Livre</h2>
      <p>Erro retornado: <code>${error || 'sem código de autorização'}</code></p>
      <h3 style="color:#FFE600;margin-top:24px">O que verificar:</h3>
      <table>
        <tr><td>redirect_uri configurado</td><td><code>${env.ml.redirectUri || 'NÃO CONFIGURADO'}</code></td></tr>
        <tr><td>client_id configurado</td><td><code>${env.ml.clientId || 'NÃO CONFIGURADO'}</code></td></tr>
      </table>
      <p>O <strong>redirect_uri</strong> acima deve estar cadastrado exatamente igual em
        <a href="https://developers.mercadolivre.com.br" target="_blank">developers.mercadolivre.com.br</a>
        → Aplicações → sua app → URLs de redirecionamento.</p>
      <p>Se o app está em modo <strong>Teste</strong>, apenas usuários na lista de testers podem autorizar.</p>
      <p><a href="/auth/config">→ Ver diagnóstico completo</a> &nbsp;|&nbsp; <a href="/auth/login">→ Tentar novamente</a></p>
      </body></html>`);
  }

  try {
    // Use per-store credentials if state=storeId was passed and store has its own app
    const storeId = req.query.state;
    let clientId = env.ml.clientId;
    let clientSecret = env.ml.clientSecret;
    if (storeId) {
      const { rows } = await pool.query('SELECT ml_client_id, ml_client_secret FROM stores WHERE id=$1', [storeId]);
      if (rows[0]?.ml_client_id)     clientId     = rows[0].ml_client_id;
      if (rows[0]?.ml_client_secret) clientSecret = rows[0].ml_client_secret;
    }

    // Exchange code for tokens
    const tokenRes = await fetch(ML_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: env.ml.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[auth] token exchange failed', tokenRes.status, err);
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${err}`);
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
      `INSERT INTO stores (id, nickname, access_token, refresh_token, token_expires_at, refresh_failures, last_refresh_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, now())
       ON CONFLICT (id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         refresh_failures = 0,
         last_refresh_error = NULL,
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
    'SELECT refresh_token, ml_client_id, ml_client_secret, refresh_failures FROM stores WHERE id = $1', [storeId]
  );
  if (!rows.length) throw new Error(`store ${storeId} not found`);

  // Guarda o refresh_token lido agora para usar no CAS (compare-and-swap)
  const oldRefreshToken = rows[0].refresh_token;
  const clientId     = rows[0].ml_client_id     || env.ml.clientId;
  const clientSecret = rows[0].ml_client_secret || env.ml.clientSecret;

  const res = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: oldRefreshToken,
    }),
  });

  if (res.status === 429) {
    // Fail fast — caller (mlClient) handles cooldown; recursive retry would flood ML OAuth
    const err = new Error(`OAUTH_RATE_LIMITED: store ${storeId}`);
    err.oauthRateLimit = true;
    throw err;
  }

  if (res.status === 400 || res.status === 401) {
    const errBody = await res.text();
    console.error(`[auth] refreshToken ${res.status} store=${storeId}: ${errBody}`);

    // CAS: incrementa falhas SÓ se o refresh_token no banco ainda é o mesmo que lemos.
    // Se o OAuth callback já salvou um refresh_token novo enquanto o POST estava em voo,
    // o WHERE não bate (rowCount=0) e não tocamos no token válido recém-salvo.
    const { rowCount } = await pool.query(
      `UPDATE stores
       SET refresh_failures = refresh_failures + 1,
           last_refresh_error = $3,
           updated_at = now()
       WHERE id = $1 AND refresh_token = $2`,
      [storeId, oldRefreshToken, errBody.slice(0, 200)]
    );

    if (rowCount === 0) {
      // OAuth callback salvou token novo enquanto o POST estava em voo — usar o novo
      console.log(`[auth] refreshToken CAS miss store=${storeId} — OAuth reconectou em paralelo, usando novo token`);
      const { rows: rc } = await pool.query('SELECT access_token FROM stores WHERE id=$1', [storeId]);
      return rc[0].access_token;
    }

    // Verifica quantas falhas acumuladas — só invalida após 3 falhas consecutivas
    const { rows: fc } = await pool.query('SELECT refresh_failures FROM stores WHERE id=$1', [storeId]);
    const failures = fc[0]?.refresh_failures ?? 1;
    if (failures < 3) {
      console.warn(`[auth] refreshToken falhou store=${storeId} (tentativa ${failures}/3) — aguardando próximo ciclo`);
      const err = new Error(`TOKEN_REFRESH_FAILED (${failures}/3): store ${storeId} — ${errBody.slice(0,200)}`);
      err.transient = true;
      throw err;
    }

    // 3+ falhas consecutivas → invalida o token definitivamente
    console.error(`[auth] refreshToken 3 falhas consecutivas store=${storeId} — invalidando token`);
    await pool.query(
      `UPDATE stores SET access_token=NULL, token_expires_at='1970-01-01', updated_at=now()
       WHERE id=$1 AND refresh_token=$2`,
      [storeId, oldRefreshToken]
    );
    const err = new Error(`TOKEN_INVALID: store ${storeId} — ${errBody.slice(0,200)}`);
    err.permanent = true;
    throw err;
  }

  if (!res.ok) throw new Error(`Refresh failed: HTTP ${res.status}`);
  const tokens = await res.json();

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  // CAS no sucesso: só salva se o refresh_token não mudou (OAuth não reconectou no meio)
  const { rowCount: successRows } = await pool.query(
    `UPDATE stores
     SET access_token=$2, refresh_token=$3, token_expires_at=$4,
         refresh_failures=0, last_refresh_error=NULL, updated_at=now()
     WHERE id=$1 AND refresh_token=$5`,
    [storeId, tokens.access_token, tokens.refresh_token, expiresAt, oldRefreshToken]
  );

  if (successRows === 0) {
    // OAuth reconectou enquanto refresh estava em voo — usa o token novo do banco
    console.log(`[auth] refreshToken sucesso mas CAS miss store=${storeId} — OAuth reconectou em paralelo`);
    const { rows: rc } = await pool.query('SELECT access_token FROM stores WHERE id=$1', [storeId]);
    return rc[0].access_token;
  }

  return tokens.access_token;
}

module.exports = router;
module.exports.refreshToken = refreshToken;
