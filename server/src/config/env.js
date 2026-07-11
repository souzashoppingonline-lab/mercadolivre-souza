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
};
