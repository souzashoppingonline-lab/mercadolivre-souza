// Notificação push da página "Dívidas do Dia" (PWA) — inscrição do aparelho e
// teste. Montada em /api/financeiro/push, ANTES de /api/financeiro, então fica
// sob o mesmo gate do módulo Financeiro (admin — ver MODULES em staffAuth.js).
// O envio diário é do worker (checkDividasPush, 07:00). Ver .claude/api.md.
const express = require('express');
const push = require('../pushService');

const router = express.Router();
const erro = (res, e) => res.status(e.status || 500).json({ error: e.message });

// Chave pública VAPID — o navegador precisa dela pra se inscrever.
router.get('/chave', async (req, res) => {
  try { res.json({ publicKey: (await push.chaves()).publicKey }); } catch (e) { erro(res, e); }
});

router.post('/inscrever', async (req, res) => {
  try {
    await push.inscrever(req.body && req.body.subscription, { topico: 'dividas', userAgent: req.get('user-agent') || '' });
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

router.post('/cancelar', async (req, res) => {
  try { res.json({ ok: true, removidas: await push.cancelar(req.body && req.body.endpoint) }); } catch (e) { erro(res, e); }
});

router.post('/teste', async (req, res) => {
  try {
    const r = await push.enviarTeste(req.body && req.body.endpoint);
    if (r !== 'ok') return res.status(502).json({ error: r === 'removida' ? 'o navegador cancelou a inscrição — ative de novo' : 'o serviço de push recusou o envio' });
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

module.exports = router;
