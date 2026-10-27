// Envio de e-mail (server/src/resendClient.js): lista de destinatários, dica
// do erro e aviso no Telegram quando falha.
const { test } = require('node:test');
const assert = require('node:assert');

const avisos = [];
require.cache[require.resolve('../src/notify')] = { id: 'n', filename: 'n', loaded: true, exports: { tgNotifyForce: async (t, m) => { avisos.push([t, m]); } } };
process.env.RESEND_API_KEY = 're_teste'; process.env.RESEND_TO_EMAIL = 'a@x.com, b@y.com';
const R = require('../src/resendClient');

test('destinatários: vírgula/ponto e vírgula viram lista', () => {
  assert.deepStrictEqual(R.destinatarios('a@x.com, b@y.com;c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.strictEqual(R.destinatarios('a@x.com'), 'a@x.com');
  assert.strictEqual(R.destinatarios(''), undefined);
});

test('dica certa pra cada erro comum do Resend', () => {
  assert.match(R.explicarErroEmail('Resend API → 403: You can only send testing emails to your own email address'), /onboarding@resend\.dev/);
  assert.match(R.explicarErroEmail('Resend API → 401: API key is invalid'), /RESEND_API_KEY inválida/);
  assert.match(R.explicarErroEmail('Resend API → 422: Invalid `to` field'), /Endereço inválido/);
  assert.match(R.explicarErroEmail('Resend API → 429: daily quota'), /Limite do plano/);
  assert.match(R.explicarErroEmail('fetch failed'), /api\.resend\.com/);
  assert.match(R.explicarErroEmail('RESEND_TO_EMAIL não configurado no .env'), /\.env/);
});

test('falha no envio → aviso no Telegram com assunto, erro e dica; sucesso não avisa; avisar:false não avisa', async () => {
  const orig = global.fetch;
  let corpo = null;
  global.fetch = async (url, o) => { corpo = JSON.parse(o.body); return { ok: false, status: 403, json: async () => ({ message: 'You can only send testing emails to your own email address' }) }; };
  await assert.rejects(R.sendEmail({ subject: 'Resumo do Dia — 26/10/2026', html: '<p>x</p>' }), /403/);
  assert.deepStrictEqual(corpo.to, ['a@x.com', 'b@y.com']);
  assert.strictEqual(avisos.length, 1);
  assert.strictEqual(avisos[0][0], 'tg_email_falha');
  assert.match(avisos[0][1], /E-mail NÃO foi enviado[\s\S]*Resumo do Dia — 26\/10\/2026[\s\S]*<code>Resend API → 403[\s\S]*💡 O remetente de teste/);
  await assert.rejects(R.sendEmail({ subject: 'Teste', html: 'x', avisar: false }));
  assert.strictEqual(avisos.length, 1);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'abc' }) });
  assert.deepStrictEqual(await R.sendEmail({ subject: 'ok', html: 'x' }), { id: 'abc' });
  assert.strictEqual(avisos.length, 1);
  global.fetch = async () => { throw new Error('fetch failed'); };
  await assert.rejects(R.sendEmail({ subject: 'Semanal', html: 'x' }));
  assert.match(avisos[1][1], /api\.resend\.com/);
  global.fetch = orig;
});
