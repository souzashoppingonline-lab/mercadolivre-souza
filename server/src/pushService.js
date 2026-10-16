// Web Push — notificação no celular mesmo com o navegador fechado (PWA
// "Dívidas do Dia"). Usado pela rota /api/financeiro/push (inscrever/testar) e
// pelo job checkDividasPush do worker.js (07:00). Ver .claude/workers.md.
//
// Chaves VAPID: geradas sozinhas no 1º uso e guardadas em app_config
// (push_vapid_public / push_vapid_private) — nenhum passo manual no .env. Os
// dois processos (server e worker) podem gerar ao mesmo tempo: o INSERT das
// duas linhas é um único comando com ON CONFLICT DO NOTHING, então vale o par
// que gravou primeiro e o outro relê do banco.
// Inscrições em push_subscriptions (migrate-v116.sql). Inscrição que o
// navegador desfez (404/410 do serviço de push) é apagada no envio.
// web-push carregado só no uso: sem `npm install` no deploy, a rota responde
// erro claro em vez de derrubar o server.js inteiro no require.
let _webpush = null;
function webpush() {
  if (_webpush) return _webpush;
  try { _webpush = require('web-push'); } catch (e) {
    const err = new Error('dependência web-push não instalada no servidor — rode `npm install` na pasta server'); err.status = 503; throw err;
  }
  return _webpush;
}
const pool = require('./db/pool');

// "subject" do VAPID (vai pro serviço de push do Google/Apple): URL do site,
// não um e-mail pessoal. PUSH_CONTACT no .env troca, se precisar.
const CONTATO = process.env.PUSH_CONTACT || 'https://multimixvendas.duckdns.org';
let _chaves = null;

async function lerChaves() {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_config WHERE key IN ('push_vapid_public', 'push_vapid_private')`
  );
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return m.push_vapid_public && m.push_vapid_private ? { publicKey: m.push_vapid_public, privateKey: m.push_vapid_private } : null;
}

async function chaves() {
  if (_chaves) return _chaves;
  let k = await lerChaves();
  if (!k) {
    const g = webpush().generateVAPIDKeys();
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ('push_vapid_public', $1), ('push_vapid_private', $2)
       ON CONFLICT (key) DO NOTHING`,
      [g.publicKey, g.privateKey]
    );
    k = await lerChaves();
  }
  webpush().setVapidDetails(CONTATO, k.publicKey, k.privateKey);
  _chaves = k;
  return k;
}

function validarInscricao(sub) {
  const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint)
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
  if (!ok) { const e = new Error('inscrição de push inválida'); e.status = 400; throw e; }
}

async function inscrever(sub, { topico = 'dividas', userAgent = '' } = {}) {
  validarInscricao(sub);
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, topico, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       topico = EXCLUDED.topico, user_agent = EXCLUDED.user_agent, fail_count = 0, last_error = NULL`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, topico, String(userAgent).slice(0, 300)]
  );
}

async function cancelar(endpoint) {
  const r = await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint || '')]);
  return r.rowCount;
}

// Envia pra UMA inscrição (linha de push_subscriptions). Retorna 'ok',
// 'removida' (navegador desfez) ou 'falha'.
async function enviarUma(linha, payload) {
  await chaves();
  const sub = { endpoint: linha.endpoint, keys: { p256dh: linha.p256dh, auth: linha.auth } };
  try {
    await webpush().sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
    await pool.query(`UPDATE push_subscriptions SET last_success_at = now(), fail_count = 0, last_error = NULL WHERE id = $1`, [linha.id]);
    return 'ok';
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [linha.id]);
      return 'removida';
    }
    await pool.query(
      `UPDATE push_subscriptions SET fail_count = fail_count + 1, last_error = $2 WHERE id = $1`,
      [linha.id, `${e.statusCode || ''} ${e.body || e.message}`.trim().slice(0, 300)]
    );
    console.error('[push] falha ao enviar:', e.statusCode || '', e.body || e.message);
    return 'falha';
  }
}

async function enviarTopico(topico, payload) {
  const { rows } = await pool.query(`SELECT * FROM push_subscriptions WHERE topico = $1`, [topico]);
  const res = { inscritos: rows.length, ok: 0, removida: 0, falha: 0 };
  for (const linha of rows) res[await enviarUma(linha, payload)]++;
  return res;
}

async function enviarTeste(endpoint) {
  const { rows } = await pool.query(`SELECT * FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint || '')]);
  if (!rows.length) { const e = new Error('este aparelho não está inscrito — ative as notificações de novo'); e.status = 404; throw e; }
  return enviarUma(rows[0], {
    title: '🔔 Notificações ativadas!',
    body: 'Todo dia às 07:00 você recebe as contas que vencem hoje.',
    url: '/pages/financeiro-dividas-hoje.html', tag: 'dividas-teste',
  });
}

async function contarInscritos(topico) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE topico = $1`, [topico]);
  return rows[0].n;
}

module.exports = { chaves, inscrever, cancelar, enviarTopico, enviarTeste, contarInscritos };
