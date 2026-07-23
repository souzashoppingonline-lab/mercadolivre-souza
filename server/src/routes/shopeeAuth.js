// OAuth flow da Shopee — o seller (dono da loja) visita /auth/shopee/login
// uma vez para autorizar o app. Tokens ficam em `stores` (mesmas colunas
// genéricas access_token/refresh_token/token_expires_at já usadas pelo ML/
// Amazon). Mesmo padrão de routes/auth.js (ML), adaptado para o fluxo de
// assinatura HMAC da Shopee em vez de Authorization Code padrão OAuth2 puro.
const express = require('express');
const pool = require('../db/pool');
const env = require('../config/env');
const { getAuthorizationUrl, exchangeCodeForToken, baseUrl } = require('../marketplaces/shopee/shopeeClient');

const router = express.Router();

const DIAG_STYLE = `body{font-family:sans-serif;background:#1a1d23;color:#f0f0f0;max-width:680px;margin:40px auto;padding:24px}
  h2{color:#FFE600;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:16px 0}
  td{padding:10px 12px;border:1px solid #2a2d35;vertical-align:top}td:first-child{width:140px;color:#888;font-size:13px}
  code{background:#2a2d35;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
  .ok{color:#4CAF50}.err{color:#f44336}.warn{color:#ff9800}
  a{color:#FFE600;text-decoration:none}p{line-height:1.6;color:#aaa}`;

// Diagnóstico — mostra partner_id e redirect_uri sem expor a partner_key
router.get('/config', (req, res) => {
  const { partnerId, redirectUri, env: shopeeEnv } = env.shopee;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Config OAuth Shopee</title>
    <style>${DIAG_STYLE}</style></head><body>
    <h2>Configuração OAuth — Shopee</h2>
    <p>Compare com o cadastrado no <a href="https://open.shopee.com" target="_blank">Shopee Open Platform Console</a> → seu app.</p>
    <table>
      <tr><td>partner_id</td><td>${partnerId ? `<code>${partnerId}</code>` : '<span class="err">❌ NÃO CONFIGURADO (SHOPEE_PARTNER_ID)</span>'}</td></tr>
      <tr><td>partner_key</td><td>${env.shopee.partnerKey ? '<span class="ok">✓ configurado (oculto)</span>' : '<span class="err">❌ NÃO CONFIGURADO (SHOPEE_PARTNER_KEY)</span>'}</td></tr>
      <tr><td>redirect_uri</td><td>${redirectUri ? `<code>${redirectUri}</code>` : '<span class="err">❌ NÃO CONFIGURADO (SHOPEE_REDIRECT_URI)</span>'}</td></tr>
      <tr><td>ambiente</td><td><code>${shopeeEnv}</code> ${shopeeEnv === 'production' ? '<span class="ok">(produção — partner.shopeemobile.com)</span>' : '<span class="err">(sandbox — partner.uat.shopeemobile.com)</span>'}</td></tr>
      <tr><td>host</td><td><code>${baseUrl(shopeeEnv)}</code></td></tr>
      <tr><td>acesso a dados sensíveis</td><td>${env.shopee.sensitiveAccess ? '<span class="ok">✓ habilitado (pede buyer_username)</span>' : '<span class="warn">— desabilitado (não pede campos sensíveis; correto se o app está "Sem acesso")</span>'}</td></tr>
    </table>
    <p><strong>O redirect_uri acima deve estar cadastrado EXATAMENTE</strong> no domínio de redirecionamento configurado no console da Shopee.</p>
    <p><a href="/auth/shopee/login">→ Tentar autorizar uma loja</a></p>
    </body></html>`);
});

// Step 1 — redireciona para a página de autorização da Shopee
// v46: Suporta ?partner_id=<id> pra usar credenciais de um partner específico (per-store).
// Se não informado, usa o global SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY.
router.get('/login', (req, res) => {
  const { partnerId: globalPartnerId, partnerKey: globalPartnerKey, env: shopeeEnv, redirectUri } = env.shopee;

  // v46: Se ?partner_id foi passado, buscar as credenciais desse partner (futura feature —
  // por ora ainda não implementado o cadastro multi-partner no admin; isso vai pra v47+).
  // Por enquanto, sempre usa global.
  const partnerId = globalPartnerId;
  const partnerKey = globalPartnerKey;

  if (!partnerId || !partnerKey || !redirectUri) {
    return res.status(500).send('Shopee não configurada — faltam SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY/SHOPEE_REDIRECT_URI no .env. Ver /auth/shopee/config.');
  }
  const url = getAuthorizationUrl({ partnerId, partnerKey, env: shopeeEnv, redirectUri });
  res.redirect(url);
});

// Step 2 — Shopee redireciona de volta com ?code=...&shop_id=...
// v46: Suporta ?partner_id=<id> pra associar partner_id específico a essa loja Shopee
// (credenciais per-store). Se não informado, deixa NULL (usa global).
router.get('/callback', async (req, res) => {
  const { code, shop_id: shopId, partner_id: queryPartnerId } = req.query;
  const { partnerId: globalPartnerId, partnerKey: globalPartnerKey, env: shopeeEnv } = env.shopee;

  if (!code || !shopId) {
    return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro OAuth Shopee</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>❌ Autorização incompleta</h2>
      <p>Faltou <code>code</code> ou <code>shop_id</code> no retorno da Shopee.</p>
      <p><a href="/auth/shopee/config">→ Ver diagnóstico</a> &nbsp;|&nbsp; <a href="/auth/shopee/login">→ Tentar novamente</a></p>
      </body></html>`);
  }

  try {
    // v46: Usar o partner_id do query (se present) ou cair pra global
    // (Isso permite testar multi-partner sem admin UI ainda implementado)
    const partnerId = queryPartnerId || globalPartnerId;
    const partnerKey = globalPartnerKey; // por enquanto, partnerKey sempre global (será v47 feature de admin)

    const tokens = await exchangeCodeForToken({ partnerId, partnerKey, env: shopeeEnv, code, shopId });
    const expiresAt = new Date(Date.now() + Number(tokens.expire_in || 14400) * 1000);

    // Id sintético em faixa reservada própria da Shopee (9100000001+), separada
    // da faixa da Amazon (9000000001-9099999999) para nunca colidir — mesmo
    // padrão de .claude/database.md, mas a Shopee tem shop_id real (guardado
    // em stores.shopee_shop_id) então o id sintético é só a chave interna.
    const { rows: existing } = await pool.query(`SELECT id FROM stores WHERE shopee_shop_id = $1`, [shopId]);
    let storeId = existing[0]?.id;

    const { rows: mp } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'SHOPEE'`);
    const marketplaceId = mp[0]?.id;
    if (!marketplaceId) throw new Error('marketplace SHOPEE não cadastrado — rode a migration');

    if (!storeId) {
      const { rows: maxRow } = await pool.query(
        `SELECT COALESCE(MAX(id), 9100000000) AS max_id FROM stores WHERE id BETWEEN 9100000000 AND 9199999999`
      );
      storeId = (BigInt(maxRow[0].max_id) + 1n).toString();
      // v46: Gravar partner_id/key per-store se foi informado no query
      await pool.query(
        `INSERT INTO stores (id, nickname, marketplace_id, shopee_shop_id, access_token, refresh_token, token_expires_at, shopee_partner_id, shopee_partner_key, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
        [storeId, `Shopee ${shopId}`, marketplaceId, shopId, tokens.access_token, tokens.refresh_token, expiresAt, queryPartnerId || null, null]
      );
    } else {
      // v46: Atualizar partner_id/key se foi informado no query
      await pool.query(
        `UPDATE stores SET access_token=$2, refresh_token=$3, token_expires_at=$4, shopee_partner_id=$5, updated_at=now() WHERE id=$1`,
        [storeId, tokens.access_token, tokens.refresh_token, expiresAt, queryPartnerId || null]
      );
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopee autorizada</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>✅ Loja Shopee autorizada</h2>
      <p>shop_id <code>${shopId}</code> conectado (store interno <code>${storeId}</code>).</p>
      ${queryPartnerId ? `<p>⚠️ Partner ID específico <code>${queryPartnerId}</code> associado a essa loja.</p>` : ''}
      <p>Reinicie o worker (<code>ml-worker-novo</code>) para essa conta começar a sincronizar — ainda sem hot-reload (mesma limitação da Amazon, ver .claude/todo.md).</p>
      </body></html>`);
  } catch (e) {
    console.error('[shopee-auth] callback error:', e.message);
    res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro OAuth Shopee</title>
      <style>${DIAG_STYLE}</style></head><body>
      <h2>❌ Falha ao trocar code por token</h2>
      <p><code>${e.message}</code></p>
      <p><a href="/auth/shopee/login">→ Tentar novamente</a></p>
      </body></html>`);
  }
});

module.exports = router;
