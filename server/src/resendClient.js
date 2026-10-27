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

// RESEND_TO_EMAIL pode ter vários endereços separados por vírgula/ponto e
// vírgula: a API do Resend quer ARRAY nesse caso — mandar a string inteira
// fazia o envio ser recusado (fechamentoMensalEmail.js já prometia lista).
function destinatarios(to) {
  const lista = (Array.isArray(to) ? to : String(to || '').split(/[,;]/)).map(e => String(e).trim()).filter(Boolean);
  return lista.length > 1 ? lista : lista[0];
}

// Erro do Resend → dica em português do que fazer (vai no aviso do Telegram).
function explicarErroEmail(msg) {
  const m = String(msg || '');
  if (/testing emails|verify a domain|own email address/i.test(m)) return 'O remetente de teste (onboarding@resend.dev) só entrega pro e-mail dono da conta Resend. Verifique seu domínio no Resend e troque RESEND_FROM_EMAIL no .env.';
  if (/domain is not verified|not verified/i.test(m)) return 'O domínio do remetente (RESEND_FROM_EMAIL) não está verificado no Resend — confira os registros DNS no painel do Resend.';
  if (/RESEND_API_KEY não configurado|RESEND_TO_EMAIL não configurado/.test(m)) return 'Falta preencher RESEND_API_KEY / RESEND_TO_EMAIL no .env do servidor e reiniciar o worker.';
  if (/→ 401|api key is invalid|invalid api key|API key/i.test(m)) return 'RESEND_API_KEY inválida ou revogada — gere outra em resend.com/api-keys e troque no .env.';
  if (/→ 403/.test(m)) return 'O Resend recusou o envio (permissão). Confira o domínio/remetente no painel do Resend.';
  if (/→ 422|invalid .*(to|from)|validation/i.test(m)) return 'Endereço inválido em RESEND_TO_EMAIL ou RESEND_FROM_EMAIL (formato: Nome <email@dominio>, vários separados por vírgula).';
  if (/→ 429|rate limit|quota|daily/i.test(m)) return 'Limite do plano do Resend estourado (plano grátis: 100/dia, 3.000/mês) ou envios rápidos demais.';
  if (/→ 5\d\d/.test(m)) return 'Instabilidade no Resend — normalmente volta sozinho; o próximo envio agendado tenta de novo.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(m)) return 'O servidor não conseguiu falar com api.resend.com (internet/DNS do servidor).';
  return 'Veja o log do worker: journalctl -u ml-worker-novo | grep "\\[email"';
}

// Aviso no Telegram quando um e-mail FALHA (pedido do usuário) — tópico
// `tg_email_falha`, tgNotifyForce (sai mesmo no silêncio: o e-mail diário é às
// 06:10 e o erro precisa chegar). Nunca lança: avisar não pode virar 2º erro.
async function avisarFalha(subject, erro) {
  try {
    const { tgNotifyForce } = require('./notify');
    const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    await tgNotifyForce('tg_email_falha',
      `📧❌ <b>E-mail NÃO foi enviado</b>\n📄 ${esc(subject || '(sem assunto)')}\n⚠️ <code>${esc(String(erro && erro.message || erro).slice(0, 300))}</code>\n💡 ${esc(explicarErroEmail(erro && erro.message || erro))}`);
  } catch (e) { console.error('[email] aviso de falha no Telegram também falhou:', e.message); }
}

// avisar: false só no botão "Enviar Teste" do Monitor (o erro já aparece na tela).
async function sendEmail({ subject, html, to = TO, avisar = true }) {
  try {
    if (!API_KEY) throw new Error('RESEND_API_KEY não configurado no .env');
    to = destinatarios(to);
    if (!to) throw new Error('RESEND_TO_EMAIL não configurado no .env');
    const res = await fetch(`${BASE}/emails`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend API → ${res.status}: ${json.message || JSON.stringify(json)}`);
    return json;
  } catch (e) {
    if (avisar) await avisarFalha(subject, e);
    throw e;
  }
}

module.exports = { sendEmail, destinatarios, explicarErroEmail, avisarFalha, isConfigured: () => !!(API_KEY && TO) };
