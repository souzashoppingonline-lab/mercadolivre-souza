// Saúde do Sistema — heartbeat por processo, contagem de filas BullMQ, último
// webhook/sync, e alertas Telegram (tg_saude) para: fila acumulando, jobs em
// dead-letter, webhooks travados e restart-loop de processo.
//
// Sem migration: usa Redis (heartbeat/boots/dedup de alerta) + tabelas que já
// existem (webhook_logs, schedule_jobs). Compartilhado entre worker.js (grava
// heartbeat 'worker' + roda checkAndAlert) e server.js (heartbeat 'server').
// A rota GET /api/sistema/saude lê o snapshot. Ver .claude/workers.md.
const os = require('os');
const fs = require('fs');
const redis = require('./db/redis');
const pool = require('./db/pool');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./config/env');
const { getQueue } = require('./queues/webhookQueue');
const { tgNotify } = require('./notify');

const HB_STALE_MS = 120 * 1000;            // heartbeat mais velho que isso = processo fora do ar
const BOOT_WINDOW_MS = 10 * 60 * 1000;     // janela para contar reinícios (restart-loop)
const BOOT_LOOP_THRESHOLD = Number(process.env.HEALTH_BOOT_LOOP || 5);
const QUEUE_BACKLOG_MAX  = Number(process.env.HEALTH_QUEUE_MAX || 300);
const FAILED_MAX         = Number(process.env.HEALTH_FAILED_MAX || 50);
const DISK_MAX_PCT       = Number(process.env.HEALTH_DISK_MAX || 90);
const MEM_MAX_PCT        = Number(process.env.HEALTH_MEM_MAX || 92);

// Métricas do servidor Linux — só `os` + fs.statfs (sem dependência/binário).
function serverMetrics() {
  const cores = os.cpus()?.length || 1;
  const [l1, l5, l15] = os.loadavg();       // média de carga 1/5/15 min
  const total = os.totalmem(), free = os.freemem();
  let disk = null;
  try {
    const st = fs.statfsSync(process.cwd());  // partição onde o app roda
    const dTotal = st.blocks * st.bsize;
    const dFree = st.bavail * st.bsize;        // espaço livre pra usuário (não-root)
    const dUsed = dTotal - (st.bfree * st.bsize);
    disk = { total: dTotal, free: dFree, used: dUsed, used_pct: dTotal ? Math.round(dUsed / dTotal * 100) : 0 };
  } catch (_) { /* statfs indisponível — disco fica null */ }
  return {
    hostname: os.hostname(), node: process.version, platform: `${os.type()} ${os.release()}`,
    cpu: { cores, load1: +l1.toFixed(2), load5: +l5.toFixed(2), load15: +l15.toFixed(2),
           load_pct: Math.round(l1 / cores * 100) },
    mem: { total, free, used: total - free, used_pct: total ? Math.round((total - free) / total * 100) : 0 },
    disk,
    uptime_server_s: Math.round(os.uptime()),
    uptime_process_s: Math.round(process.uptime()),
  };
}

// ── Heartbeat + reinícios ──────────────────────────────────
async function recordBoot(proc) {
  try {
    const k = `health:boots:${proc}`;
    await redis.lpush(k, Date.now());
    await redis.ltrim(k, 0, 49);
    await redis.expire(k, 3 * 3600);
  } catch (_) { /* ignore */ }
}

// Grava o timestamp atual a cada 30s (TTL 1 dia — a idade é o que importa,
// não a existência, para distinguir "nunca subiu" de "parou de bater").
function startHeartbeat(proc) {
  const beat = () => redis.set(`health:hb:${proc}`, Date.now(), 'EX', 86400).catch(() => {});
  recordBoot(proc);
  beat();
  const t = setInterval(beat, 30 * 1000);
  if (t.unref) t.unref();
  return t;
}

async function bootsInWindow(proc) {
  try {
    const items = await redis.lrange(`health:boots:${proc}`, 0, -1);
    const cutoff = Date.now() - BOOT_WINDOW_MS;
    return items.map(Number).filter((ts) => ts >= cutoff).length;
  } catch (_) { return 0; }
}

// ── Contagem das filas BullMQ ──────────────────────────────
let _legacyQ = null;
function legacyQueue() {
  if (!_legacyQ) {
    _legacyQ = new Queue('ml-webhooks', { connection: new IORedis(env.redisUrl, { maxRetriesPerRequest: null }) });
  }
  return _legacyQ;
}

async function queueCounts() {
  const { rows } = await pool.query(
    `SELECT id FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')`
  );
  const handles = [getQueue('default'), legacyQueue(), ...rows.map((r) => getQueue(String(r.id)))];
  let waiting = 0, active = 0, delayed = 0, failed = 0;
  for (const q of handles) {
    try {
      const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      waiting += c.waiting || 0; active += c.active || 0; delayed += c.delayed || 0; failed += c.failed || 0;
    } catch (_) { /* fila inexistente/indisponível — ignora */ }
  }
  return { waiting, active, delayed, failed, backlog: waiting + delayed };
}

// ── Snapshot lido pela rota / página ───────────────────────
function procStatus(hb, boots) {
  const beat = hb ? Number(hb) : null;
  const age = beat ? Date.now() - beat : null;
  return {
    up: beat != null && age < HB_STALE_MS,
    down: beat != null && age >= HB_STALE_MS, // já bateu antes e parou (≠ nunca subiu)
    last_beat: beat,
    boots_10min: boots,
    restart_loop: boots >= BOOT_LOOP_THRESHOLD,
  };
}

async function getSnapshot() {
  const [filas, hbWorker, hbServer, bootsWorker, bootsServer] = await Promise.all([
    queueCounts().catch(() => null),
    redis.get('health:hb:worker').catch(() => null),
    redis.get('health:hb:server').catch(() => null),
    bootsInWindow('worker'),
    bootsInWindow('server'),
  ]);

  const { rows: whRows } = await pool.query(
    `SELECT topic, received_at, status FROM webhook_logs ORDER BY id DESC LIMIT 1`
  );
  const { rows: syncs } = await pool.query(
    `SELECT name, cron, last_run, duration_ms, status FROM schedule_jobs ORDER BY last_run DESC NULLS LAST`
  );

  // Nota: NÃO usamos COUNT(webhook_logs WHERE status='pending') como sinal de
  // "travado" — o gateway grava 1 linha 'pending' por webhook recebido, mas o
  // jobId estável deduplica no BullMQ e os duplicados nunca viram job (nem
  // 'processed'), então acumulam 'pending' pra sempre (log, não fila parada). O
  // sinal real de webhook empilhando é o backlog do BullMQ (filas.backlog).
  return {
    filas,
    ultimo_webhook: whRows[0] || null,
    syncs,
    processos: {
      worker: procStatus(hbWorker, bootsWorker),
      server: procStatus(hbServer, bootsServer),
    },
    servidor: (() => { try { return serverMetrics(); } catch (_) { return null; } })(),
    limites: {
      backlog: QUEUE_BACKLOG_MAX, failed: FAILED_MAX, boot_loop: BOOT_LOOP_THRESHOLD,
      disk: DISK_MAX_PCT, mem: MEM_MAX_PCT,
    },
    ts: Date.now(),
  };
}

// ── Alertas (worker roda a cada 5 min + 90s após o boot) ───
// Dedup no Redis: só dispara na transição bom→ruim; limpa quando normaliza.
async function alertOnce(kind, isBad, message) {
  const key = `health:alerted:${kind}`;
  try {
    const already = await redis.get(key);
    if (isBad && !already) {
      await redis.set(key, '1', 'EX', 6 * 3600);
      await tgNotify('tg_saude', message);
    } else if (!isBad && already) {
      await redis.del(key);
    }
  } catch (_) { /* ignore */ }
}

async function checkAndAlert() {
  try {
    const snap = await getSnapshot();
    const f = snap.filas || {};
    await alertOnce('backlog', (f.backlog || 0) > QUEUE_BACKLOG_MAX,
      `⚠️ <b>Fila acumulando</b>\n${f.backlog} jobs na fila (aguardando+atrasados). Limite ${QUEUE_BACKLOG_MAX}.\nVer Saúde do Sistema.`);
    await alertOnce('failed', (f.failed || 0) > FAILED_MAX,
      `🚨 <b>Jobs em dead-letter</b>\n${f.failed} jobs na fila de falha. Limite ${FAILED_MAX}.\n<code>journalctl -u ml-worker-novo -n 80</code>`);
    await alertOnce('boot_worker', snap.processos.worker.restart_loop,
      `🚨 <b>Worker reiniciando em loop</b>\n${snap.processos.worker.boots_10min} reinícios em 10min — provável crash-loop.\n<code>systemctl status ml-worker-novo</code>`);
    await alertOnce('boot_server', snap.processos.server.restart_loop,
      `🚨 <b>Servidor reiniciando em loop</b>\n${snap.processos.server.boots_10min} reinícios em 10min.\n<code>systemctl status ml-dashboard-novo</code>`);
    await alertOnce('server_down', snap.processos.server.down,
      `🚨 <b>Servidor sem heartbeat</b>\nml-dashboard-novo parou de responder há +2min. Pode estar fora do ar.`);
    const sv = snap.servidor || {};
    await alertOnce('disk', sv.disk && sv.disk.used_pct > DISK_MAX_PCT,
      `🚨 <b>Disco quase cheio</b>\n${sv.disk?.used_pct}% usado (livre ${sv.disk ? (sv.disk.free / 1e9).toFixed(1) : '?'} GB). Limpe vídeos/backups/logs antes de encher — disco cheio derruba o serviço.`);
    await alertOnce('mem', sv.mem && sv.mem.used_pct > MEM_MAX_PCT,
      `⚠️ <b>Memória alta</b>\nRAM em ${sv.mem?.used_pct}% (livre ${sv.mem ? (sv.mem.free / 1e9).toFixed(1) : '?'} GB).`);
  } catch (e) {
    console.error('[health] checkAndAlert erro:', e.message);
  }
}

module.exports = { startHeartbeat, getSnapshot, checkAndAlert, recordBoot };
