require('dotenv').config();

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
    // 'sandbox' (partner.uat.shopeemobile.com) até confirmar app de produção aprovado (ver .claude/shopee.md)
    env: process.env.SHOPEE_ENV || 'sandbox',
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
};
