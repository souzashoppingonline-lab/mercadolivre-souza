require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const apiRoutes = require('./routes/api');
const turboRoutes = require('./routes/turbo');
const amazonRoutes = require('./routes/amazon');
const shopeeRoutes = require('./routes/shopee');
const tasksRoutes = require('./routes/tasks');
const embalagemRoutes = require('./routes/embalagem');
const webhookGateway = require('./routes/webhookGateway');
const authRoutes = require('./routes/auth');
const shopeeAuthRoutes = require('./routes/shopeeAuth');
const { router: staffAuthRoutes, requireStaffAuth } = require('./routes/staffAuth');
const wsHub = require('./ws/hub');

const app = express();
app.use(cors());
// Webhook Shopee ("Mecanismo de Empurra") — montado ANTES do express.json()
// global porque a validação de assinatura precisa do corpo CRU (o router usa
// express.raw()). Isolado do gateway ML; público (não passa pelo gate de auth,
// que só é registrado abaixo). Ver routes/shopeeWebhook.js e .claude/shopee.md.
app.use('/webhooks/shopee', require('./routes/shopeeWebhook'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Chrome Extension — coleta de dados de anúncios (rota pública, antes do gate de auth)
app.use('/extension/collect', require('./routes/extensionCollect'));
// Análise de Produtos — extensão lê o produto ativo e envia os anúncios coletados.
app.use('/extension', require('./routes/extensionAnalise'));

// Print Agent — rotas consumidas pelo agente da expedição (headless, sem cookie).
// Auth por token de estação, então ficam ANTES do gate de staff. Ver .claude/print-agent.md.
app.use('/print-agent', require('./routes/printAgent'));

// Login de acesso restrito (staff) — ver .claude/auth-staff.md. Desligado
// por padrão (STAFF_AUTH_ENABLED=false); a própria função já ignora tudo
// quando o gate está desligado, então isso é seguro mesmo antes de criar
// o 1º usuário admin.
app.use(requireStaffAuth);
app.use('/auth/staff', staffAuthRoutes);

// Frontend reads exclusively from here.
app.use('/api', apiRoutes);
app.use('/api/turbo', turboRoutes);
// Dashboard Amazon — isolado, não reutiliza nada do ML (ver routes/amazon.js).
app.use('/api/amazon', amazonRoutes);
// Dashboard Shopee — mesmo padrão isolado da Amazon (ver routes/shopee.js).
app.use('/api/shopee', shopeeRoutes);
// Agenda Trello — quadro Kanban independente (ver .claude/task-engine.md).
app.use('/api/tasks', tasksRoutes);
// Embalagem — bipagem de etiqueta + vídeo de conferência (ver .claude/embalagem.md).
app.use('/api/embalagem', embalagemRoutes);
// Print Agent — gestão (enfileirar impressão + estações). Ver .claude/print-agent.md.
app.use('/api/print', require('./routes/print'));
// Análise de Produtos — cadastro + fila de coleta (lado dashboard). Ver .claude/analise-produtos.md.
app.use('/api/analise', require('./routes/analise'));
// Rankeamento de anúncios novos — acompanha cada venda/alteração (ver .claude/rankeamento.md).
app.use('/api/ranking', require('./routes/ranking'));
// Módulo Financeiro — lê do Supabase separado, read-only (só admin — ver MODULES). Ver .claude/modules.md.
app.use('/api/financeiro', require('./routes/financeiro'));

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

// Estático (index.html, css/, js/, pages/, assets/) — antes servido direto
// pelo nginx (bypassando este processo); passou a ser servido pelo Express
// pra que requireStaffAuth (montado acima) consiga proteger o CARREGAMENTO
// das páginas, não só as chamadas /api. O nginx precisa trocar seu
// `location /` de "root ..." para "proxy_pass http://127.0.0.1:PORT;" — ver
// .claude/auth-staff.md e .claude/deployment.md.
const staticRoot = path.join(__dirname, '..', '..');
app.use(express.static(staticRoot));
// SPA fallback (equivalente ao try_files $uri $uri/ /index.html; do nginx),
// mas só pra navegação de página (não pra /api, /webhooks, /auth, /ml, /ws
// que já têm suas próprias rotas e devem retornar 404 normalmente se não
// existirem).
app.get('*', (req, res, next) => {
  const p = req.path;
  if (p.startsWith('/api') || p.startsWith('/webhooks') || p.startsWith('/auth') || p.startsWith('/ml') || p.startsWith('/ws') || p.startsWith('/print-agent') || p.startsWith('/extension') || p === '/health') {
    return next();
  }
  res.sendFile(path.join(staticRoot, 'index.html'));
});

const server = http.createServer(app);
wsHub.attach(server);

server.listen(env.port, () => {
  console.log(`[server] listening on :${env.port}`);
  console.log(`[server] REST API:    http://localhost:${env.port}/api`);
  console.log(`[server] Webhook URL: http://localhost:${env.port}/webhooks/ml`);
  console.log(`[server] WebSocket:   ws://localhost:${env.port}/ws`);
  // Saúde do Sistema — heartbeat 'server' (o worker é quem alerta). Ver health.js.
  try { require('./health').startHeartbeat('server'); } catch (e) { console.warn('[health] heartbeat server falhou:', e.message); }
});

server.keepAliveTimeout = 3600000;
server.headersTimeout   = 3601000;
