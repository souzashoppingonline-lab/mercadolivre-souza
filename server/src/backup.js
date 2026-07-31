// Backup do Postgres — pg_dump diário compactado (.sql.gz), com retenção, e um
// status legível pelo sino do topbar (js/layout.js). Guardado FORA da pasta
// servida estaticamente (senão o dump ficaria baixável sem auth); o download
// passa só por /api (atrás do gate de staff). Ver workers.md/decisions.md.
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');
const { spawn } = require('child_process');
const pool = require('./db/pool');
const env = require('./config/env');

const REPO_ROOT = path.join(__dirname, '..', '..');            // .../mercadolivre-souza (raiz servida)
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(REPO_ROOT, '..', 'ml-backups'); // fora da raiz
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);
const NAME_RE = /^ml-backup-[0-9T._-]+\.sql\.gz$/;             // valida nome no download (anti path traversal)

async function saveStatus(obj) {
  try {
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ('backup_status', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(obj)]
    );
  } catch (e) { console.error('[backup] saveStatus:', e.message); }
}

async function readStatus() {
  try {
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='backup_status'`);
    return rows[0]?.value ? JSON.parse(rows[0].value) : null;
  } catch (_) { return null; }
}

// Executa pg_dump → gzip → arquivo. Resolve com o status.
function pgDumpToFile(filePath) {
  return new Promise((resolve, reject) => {
    if (!env.databaseUrl) return reject(new Error('DATABASE_URL não configurada'));
    const out = fs.createWriteStream(filePath);
    const gzip = zlib.createGzip();
    // Passa a URI de conexão como argumento; --no-owner/--no-privileges deixam
    // o dump restaurável em qualquer banco (útil pro clone em outro servidor).
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '-d', env.databaseUrl]);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'pg_dump não encontrado no servidor' : e.message)));
    dump.stdout.pipe(gzip).pipe(out);
    out.on('error', reject);
    dump.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump saiu com código ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function pruneOld() {
  try {
    const files = await fsp.readdir(BACKUP_DIR).catch(() => []);
    const cutoff = Date.now() - RETENTION_DAYS * 864e5;
    for (const f of files) {
      if (!NAME_RE.test(f)) continue;
      const fp = path.join(BACKUP_DIR, f);
      const st = await fsp.stat(fp).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.unlink(fp).catch(() => {});
    }
  } catch (e) { console.warn('[backup] prune:', e.message); }
}

let _running = false;
const isRunning = () => _running;

// Roda um backup agora. Grava status (ok/erro) e faz retenção. Retorna o status.
async function runBackup() {
  if (_running) return { ...(await readStatus()), running: true };
  _running = true;
  try {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '');
  const name = `ml-backup-${ts}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, name);
  try {
    await pgDumpToFile(filePath);
    const st = await fsp.stat(filePath);
    const status = { ts: Date.now(), ok: true, file: name, size: st.size, error: null };
    await saveStatus(status);
    await pruneOld();
    console.log(`[backup] ok: ${name} (${(st.size / 1e6).toFixed(1)} MB)`);
    return status;
  } catch (e) {
    await fsp.unlink(filePath).catch(() => {}); // não deixa arquivo parcial/corrompido
    const status = { ts: Date.now(), ok: false, file: null, size: 0, error: e.message };
    await saveStatus(status);
    console.error('[backup] falhou:', e.message);
    return status;
  }
  } finally { _running = false; }
}

// Snapshot pro sino: último status + lista de arquivos + "due" (precisa fazer).
async function getStatus() {
  const last = await readStatus();
  let files = [];
  try {
    const names = await fsp.readdir(BACKUP_DIR).catch(() => []);
    for (const f of names.filter((n) => NAME_RE.test(n))) {
      const st = await fsp.stat(path.join(BACKUP_DIR, f)).catch(() => null);
      if (st) files.push({ name: f, size: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);
  } catch (_) { /* ignore */ }
  // "due": nunca fez, último falhou, ou o último com sucesso tem +26h.
  const ageOk = last && last.ok && (Date.now() - last.ts < 26 * 3600 * 1000);
  return { last, files, due: !ageOk, retention_days: RETENTION_DAYS };
}

function filePathIfValid(name) {
  if (!NAME_RE.test(name)) return null;
  const fp = path.join(BACKUP_DIR, path.basename(name));
  return fs.existsSync(fp) ? fp : null;
}

module.exports = { runBackup, getStatus, filePathIfValid, isRunning, BACKUP_DIR };
