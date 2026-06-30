require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const env = require('./config/env');
const apiRoutes = require('./routes/api');
const webhookGateway = require('./routes/webhookGateway');
const authRoutes = require('./routes/auth');
const wsHub = require('./ws/hub');

const app = express();
app.use(cors());
app.use(express.json());

// Frontend reads exclusively from here.
app.use('/api', apiRoutes);

// Only Mercado Livre talks to this.
app.use('/webhooks', webhookGateway);

// OAuth flow — store owners visit /auth/login once to authorize.
app.use('/auth', authRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
wsHub.attach(server);

server.listen(env.port, () => {
  console.log(`[server] listening on :${env.port}`);
  console.log(`[server] REST API:    http://localhost:${env.port}/api`);
  console.log(`[server] Webhook URL: http://localhost:${env.port}/webhooks/ml`);
  console.log(`[server] WebSocket:   ws://localhost:${env.port}/ws`);
});
