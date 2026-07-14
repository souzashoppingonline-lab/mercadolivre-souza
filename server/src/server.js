require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const env = require('./config/env');
const apiRoutes = require('./routes/api');
const turboRoutes = require('./routes/turbo');
const amazonRoutes = require('./routes/amazon');
const webhookGateway = require('./routes/webhookGateway');
const authRoutes = require('./routes/auth');
const shopeeAuthRoutes = require('./routes/shopeeAuth');
const wsHub = require('./ws/hub');

const app = express();
app.use(cors());
app.use(express.json());

// Frontend reads exclusively from here.
app.use('/api', apiRoutes);
app.use('/api/turbo', turboRoutes);
// Dashboard Amazon — isolado, não reutiliza nada do ML (ver routes/amazon.js).
app.use('/api/amazon', amazonRoutes);

// Only Mercado Livre talks to this.
app.use('/webhooks', webhookGateway);

// Shopee OAuth — mesmo padrão do ML, fluxo de assinatura HMAC próprio (ver
// .claude/shopee.md). Montada antes de '/auth' para não competir com as
// rotas do ML nesse mesmo prefixo.
app.use('/auth/shopee', shopeeAuthRoutes);
// OAuth flow — store owners visit /auth/login once to authorize.
app.use('/auth', authRoutes);
// ML app has /ml/callback configured as redirect_uri
app.use('/ml', authRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
wsHub.attach(server);

server.listen(env.port, () => {
  console.log(`[server] listening on :${env.port}`);
  console.log(`[server] REST API:    http://localhost:${env.port}/api`);
  console.log(`[server] Webhook URL: http://localhost:${env.port}/webhooks/ml`);
  console.log(`[server] WebSocket:   ws://localhost:${env.port}/ws`);
});

server.keepAliveTimeout = 3600000;
server.headersTimeout   = 3601000;
