// Resend API client — envia e-mails de relatório (resumo diário, top
// vendas, relatório semanal). Credencial só via .env (RESEND_API_KEY,
// RESEND_FROM_EMAIL, RESEND_TO_EMAIL), mesmo padrão do notionClient.js —
// não editável pela UI. O que é editável pela UI (Monitor) é só o toggle
// liga/desliga de cada relatório, guardado em app_config (ver routes/api.js
// GET/PATCH /config/email).
const BASE = 'https://api.resend.com';
const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM_EMAIL || 'ML Dashboard <onboarding@resend.dev>';
const TO = process.env.RESEND_TO_EMAIL;

async function sendEmail({ subject, html, to = TO }) {
  if (!API_KEY) throw new Error('RESEND_API_KEY não configurado no .env');
  if (!to) throw new Error('RESEND_TO_EMAIL não configurado no .env');
  const res = await fetch(`${BASE}/emails`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend API → ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

module.exports = { sendEmail, isConfigured: () => !!(API_KEY && TO) };
