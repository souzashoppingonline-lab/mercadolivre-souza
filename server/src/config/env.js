// Caminho ANCORADO no arquivo (__dirname), não em process.cwd() — sem isso,
// dotenv.config() só acha o .env quando o comando é rodado de dentro de
// server/ (fluxo normal do systemd/npm start). Qualquer script standalone
// (server/scripts/*.js) rodado da raiz do repo — ou de qualquer outro lugar —
// via `node server/scripts/x.js` tinha env.* silenciosamente undefined,
// porque o cwd não é server/. Descoberto ao rodar verificarDespesa.js da
// raiz do repo (ver .claude/deployment.md: .env fica em server/.env, NUNCA
// na raiz). Ver .claude/known-bugs.md.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

module.exports = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  ml: {
    clientId: process.env.ML_CLIENT_ID,
    clientSecret: process.env.ML_CLIENT_SECRET,
    redirectUri: process.env.ML_REDIRECT_URI,
    webhookSecret: process.env.ML_WEBHOOK_SECRET,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  // Amazon SP-API — usado por server/src/marketplaces/amazon/amazonClient.js,
  // consumido pelo AmazonPollingEventSource (ver .claude/amazon.md).
  amazon: {
    appId: process.env.AMAZON_APP_ID,
    lwaClientId: process.env.AMAZON_LWA_CLIENT_ID,
    lwaClientSecret: process.env.AMAZON_LWA_CLIENT_SECRET,
    refreshToken: process.env.AMAZON_REFRESH_TOKEN,
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID,
    region: process.env.AMAZON_REGION || 'na',
    // 'sandbox' até o app ter acesso de produção aprovado pela Amazon (ver .claude/amazon.md)
    env: process.env.AMAZON_ENV || 'sandbox',
  },
  // Shopee Open Platform v2 — usado por server/src/marketplaces/shopee/shopeeClient.js,
  // consumido pelo ShopeePollingEventSource (ver .claude/shopee.md). partnerId/partnerKey
  // identificam o app (não a loja) — o mesmo par vale para todas as contas Shopee.
  shopee: {
    partnerId: process.env.SHOPEE_PARTNER_ID,
    partnerKey: process.env.SHOPEE_PARTNER_KEY,
    redirectUri: process.env.SHOPEE_REDIRECT_URI,
    // 'sandbox' (partner.uat.shopeemobile.com) ou 'production' (partner.shopeemobile.com).
    // Trocar para 'production' quando o app estiver aprovado e as credenciais forem as "ao vivo" (ver .claude/shopee.md).
    env: process.env.SHOPEE_ENV || 'sandbox',
    // Campos SENSÍVEIS (buyer_username, endereço) só podem ser pedidos ao
    // get_order_detail se o app tiver "Acesso a dados sensíveis" aprovado no
    // console. Sem isso, pedir esses campos em produção quebra a chamada — por
    // padrão NÃO pedimos (ver getOrder em shopeeClient.js e .claude/shopee.md).
    sensitiveAccess: process.env.SHOPEE_SENSITIVE_ACCESS === 'true',
    // Webhook ("Mecanismo de Empurra"): valida a assinatura HMAC do push por
    // padrão. SHOPEE_WEBHOOK_VERIFY=false desliga a validação (escape hatch pro
    // 1º teste, enquanto se confirma o formato exato da assinatura no console).
    webhookVerify: process.env.SHOPEE_WEBHOOK_VERIFY !== 'false',
    // Chave SEPARADA que a Shopee usa pra assinar os pushes ("Chave de parceiro
    // Live Push" no console → Mecanismo de Empurra) — NÃO é a partner_key da API.
    // Sem ela, a validação da assinatura do webhook falha (verified=false).
    pushPartnerKey: process.env.SHOPEE_PUSH_PARTNER_KEY,
  },
  // TikTok Shop Partner API — usado por server/src/marketplaces/tiktok/tiktokClient.js,
  // consumido pelo TiktokPollingEventSource (ver .claude/tiktok.md). appKey/appSecret
  // identificam o app (não a loja) — o mesmo par vale para todas as contas TikTok.
  tiktok: {
    appKey: process.env.TIKTOK_APP_KEY,
    appSecret: process.env.TIKTOK_APP_SECRET,
    redirectUri: process.env.TIKTOK_REDIRECT_URI,
    // Chave de assinatura do webhook — TikTok usa a MESMA app_secret (verificar
    // se muda quando o app estiver criado; Shopee usa uma chave separada, ver
    // .claude/tiktok.md "O que falta confirmar").
    webhookVerify: process.env.TIKTOK_WEBHOOK_VERIFY !== 'false',
  },
  // Módulo Financeiro — banco Supabase SEPARADO (não o Postgres principal).
  // Read-only via REST (PostgREST). Isolado: nunca migra/escreve por padrão.
  // Ver .claude/modules.md. Sem URL+KEY, o módulo fica "não configurado".
  financeiro: {
    supabaseUrl: process.env.SUPABASE_FIN_URL,   // ex: https://<ref>.supabase.co
    supabaseKey: process.env.SUPABASE_FIN_KEY,   // chave anon (respeita RLS) ou service_role (ignora RLS) — só no servidor
  },
  // Login de acesso restrito (staff) — ver .claude/auth-staff.md.
  staffAuth: {
    // Desliga o gate inteiro na hora (sem precisar reverter deploy) se algo
    // travar o acesso — "STAFF_AUTH_ENABLED=false" no .env + restart. Fica
    // ligado por padrão só depois que o usuário rodar o script de criação
    // do 1º usuário admin (ver server/scripts/createStaffUser.js).
    enabled: process.env.STAFF_AUTH_ENABLED === 'true',
    jwtSecret: process.env.STAFF_JWT_SECRET,
    // Sessão de longa duração (dias) — pedido explícito do usuário pra não
    // precisar logar toda hora.
    sessionDays: Number(process.env.STAFF_SESSION_DAYS || 180),
  },
  // Impressora térmica — rótulos de embalagem com QR code (ver .claude/embalagem.md)
  // Dois modos: 1) THERMAL_PROXY_URL (servidor em nuvem → proxy local) 2) THERMAL_PRINTER_IP direto (rede)
  thermalPrinter: {
    ip: process.env.THERMAL_PRINTER_IP,
    port: Number(process.env.THERMAL_PRINTER_PORT || 9100),
  },
  thermalProxyUrl: process.env.THERMAL_PROXY_URL,
};
