// OAuth flow do TikTok Shop — o vendedor visita /auth/tiktok/login uma vez
// para autorizar o app. Tokens ficam em `stores` (mesmas colunas genéricas
// access_token/refresh_token/token_expires_at já usadas pelo ML/Amazon/
// Shopee). Mesmo padrão de routes/shopeeAuth.js, adaptado pro fluxo
// grant_type=authorized_code do TikTok Shop. Ver .claude/tiktok.md.
const express = require('express');
const pool = require('../db/pool');
const env = require('../config/env');
const { getAuthorizationUrl, exchangeCodeForToken, TiktokClient } = require('../marketplaces/tiktok/tiktokClient');

const router = express.Router();

const DIAG_STYLE = `body{font-family:sans-serif;background:#1a1d23;color:#f0f0f0;max-width:680px;margin:40px auto;padding:24px}
  h2{color:#ff0050;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:16px 0}
  td{padding:10px 12px;border:1px solid #2a2d35;vertical-align:top}td:first-child{width:140px;color:#888;font-size:13px}
  code{background:#2a2d35;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
  .ok{color:#4CAF50}.err{color:#f44336}.warn{color:#ff9800}
  a{color:#ff0050;text-decoration:none}p{line-height:1.6;color:#aaa}`;

// Diagnóstico — mostra app_key e redirect_uri sem expor o app_secret
router.get('/config', (req, res) => {
  const { appKey, redirectUri } = env.tiktok;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Config OAuth TikTok Shop</title>
    <style>${DIAG_STYLE}</style></head><body>
    <h2>Configuração OAuth — TikTok Shop</h2>
    <p>Compare com o cadastrado no <a href="https://partner.tiktokshop.com" target="_blank">TikTok Shop Partner Center</a> → seu app.</p>
    <table>
      <tr><td>app_key</td><td>${appKey ? `<code>${appKey}</code>` : '<span class="err">❌ NÃO CONFIGURADO (TIKTOK_APP_KEY)</span>'}</td></tr>
      <tr><td>app_secret</td><td>${env.tiktok.appSecret ? '<span class="ok">✓ configurado (oculto)</span>' : '<span class="err">❌ NÃO CONFIGURADO (TIKTOK_APP_SECRET)</span>'}</td></tr>
      <tr><td>redirect_uri</td><td>${redirectUri ? `<code>${redirectUri}</code>` : '<span class="err">❌ NÃO CONFIGURADO (TIKTOK_REDIRECT_URI)</span>'}</td></tr>
    </table>
    <p><strong>O redirect_uri acima deve estar cadastrado EXATAMENTE</strong> no app do Partner Center — é lá que ele é configurado; a URL de autorização abaixo NÃO leva <code>redirect_uri</code> como parâmetro (confirmado contra o SDK de referência, ver .claude/tiktok.md), o TikTok Shop sempre volta pra URL fixa cadastrada no app.</p>
    <p><a href="/auth/tiktok/login">→ Tentar autorizar uma loja</a></p>
    </body></html>`);
});

// Step 1 — redireciona para a página de autorização do TikTok Shop
router.get('/login', (req, res) => {
  const { appKey, redirectUri } = env.tiktok;
  if (!appKey || !redirectUri) {
    return res.status(500).send('TikTok Shop não configurado — faltam TIKTOK_APP_KEY/TIKTOK_REDIRECT_URI no .env. Ver /auth/tiktok/config.');
  }
  const url = getAuthorizationUrl({ appKey });
  res.redirect(url);
});

// Step 2 — TikTok Shop redireciona de volta com ?code=...
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  const { appKey, appSecret } = env.tiktok;

  if (!code) {
    return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro OAuth TikTok Shop</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>❌ Autorização incompleta</h2>
      <p>Faltou <code>code</code> no retorno do TikTok Shop.</p>
      <p><a href="/auth/tiktok/config">→ Ver diagnóstico</a> &nbsp;|&nbsp; <a href="/auth/tiktok/login">→ Tentar novamente</a></p>
      </body></html>`);
  }

  try {
    const tokens = await exchangeCodeForToken({ appKey, appSecret, code });
    const expiresAt = new Date(Date.now() + Number(tokens.access_token_expire_in || 7 * 24 * 3600) * 1000);

    // CONFIRMADO no SDK de referência: token/get NÃO devolve shop_id/
    // shop_cipher — é preciso chamar GET authorization/{version}/shops com o
    // access_token recém-emitido pra descobrir a(s) loja(s) autorizada(s).
    const authClient = new TiktokClient({ appKey, appSecret, accessToken: tokens.access_token });
    const shops = await authClient.getAuthorizedShops().catch((e) => {
      console.error('[tiktok-auth] getAuthorizedShops falhou:', e.message);
      return [];
    });
    // ⚠️ Nome exato dos campos dentro de cada item de `shops` (shop_id vs id,
    // shop_cipher vs cipher) não confirmado — o SDK só expõe a chamada, não
    // o shape da resposta. Tenta as variantes mais prováveis.
    const shop = shops[0] || {};
    const shopId = shop.shop_id || shop.id || null;
    const shopCipher = shop.shop_cipher || shop.cipher || null;

    const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'TIKTOK'`);
    const marketplaceId = mp[0]?.id;
    if (!marketplaceId) throw new Error('marketplace TIKTOK não cadastrado — rode a migration');

    // Id sintético em faixa reservada própria do TikTok (9200000001+), separada
    // das faixas da Amazon (9000000001+) e Shopee (9100000001+) pra nunca colidir.
    const { rows: existing } = shopId ? await pool.query(`SELECT id FROM stores WHERE tiktok_shop_id = $1`, [shopId]) : { rows: [] };
    let storeId = existing[0]?.id;

    if (!storeId) {
      const { rows: maxRow } = await pool.query(
        `SELECT COALESCE(MAX(id), 9200000000) AS max_id FROM stores WHERE id BETWEEN 9200000000 AND 9299999999`
      );
      storeId = (BigInt(maxRow[0].max_id) + 1n).toString();
      await pool.query(
        `INSERT INTO stores (id, nickname, marketplace_id, tiktok_shop_id, tiktok_shop_cipher, access_token, refresh_token, token_expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
        [storeId, `TikTok Shop ${shopId || storeId}`, marketplaceId, shopId, shopCipher, tokens.access_token, tokens.refresh_token, expiresAt]
      );
    } else {
      await pool.query(
        `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, tiktok_shop_cipher=$5, updated_at=now() WHERE id=$1`,
        [storeId, tokens.access_token, tokens.refresh_token, expiresAt, shopCipher]
      );
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>TikTok Shop autorizado</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>${shopId ? '✅' : '⚠️'} Loja TikTok Shop autorizada</h2>
      ${!shopId ? '<p class="warn">Token emitido, mas getAuthorizedShops() não retornou nenhuma loja — conferir os logs (`console.error`) e o nome real do campo na resposta antes de confiar no sync (ver .claude/tiktok.md).</p>' : ''}
      <p>shop_id <code>${shopId || '—'}</code> conectado (store interno <code>${storeId}</code>).</p>
      <p>Reinicie o worker (<code>ml-worker-novo</code>) para essa conta começar a sincronizar — ainda sem hot-reload (mesma limitação da Amazon/Shopee, ver .claude/todo.md).</p>
      </body></html>`);
  } catch (e) {
    console.error('[tiktok-auth] callback error:', e.message);
    res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro OAuth TikTok Shop</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>❌ Falha ao trocar code por token</h2>
      <p><code>${e.message}</code></p>
      <p><a href="/auth/tiktok/login">→ Tentar novamente</a></p>
      </body></html>`);
  }
});

module.exports = router;
