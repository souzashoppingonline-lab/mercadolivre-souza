// Vídeo de devolução — o analista grava, na página Devoluções, a abertura do
// pacote devolvido pra usar como prova na disputa com o Mercado Livre (produto
// diferente, quebrado, faltando). Mesmo padrão do vídeo de embalagem
// (routes/embalagem.js): multer em disco, `res.sendFile` com Range pro player.
// Montado em /api/devolucao-videos (admin — mesmo gate do resto de /api).
// Também cria o LINK PÚBLICO (token) de um vídeo de devolução OU de embalagem,
// servido por `publicRouter` em /api/publico/video (sem login — staffAuth.js).
// Tabelas return_videos / video_links (migrate-v117.sql). Retenção 90 dias
// (cleanupReturnVideos, worker). Ver .claude/embalagem.md.
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db/pool');

const router = express.Router();
const publicRouter = express.Router();

const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'devolucao-videos');
const MIMES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const tipoBase = m => String(m || '').split(';')[0].trim().toLowerCase();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(STORAGE_ROOT, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const id = String(req.body.return_id || 'sem-id').replace(/[^0-9]/g, '') || 'sem-id';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `dev_${id}_${stamp}.${MIMES[tipoBase(file.mimetype)] || 'webm'}`);
  },
});
// 500MB: gravação de devolução pode ser mais longa que a de embalagem
// (abrir caixa, mostrar defeito em detalhe); limite é só trava de segurança.
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(MIMES[tipoBase(file.mimetype)] ? null : new Error(`formato de vídeo não aceito: ${file.mimetype}`), !!MIMES[tipoBase(file.mimetype)]),
});

// Nome do arquivo baixado: devolucao_<reclamação>_pedido_<pedido>_<data>.mp4
function nomeDownload(v, prefixo = 'devolucao') {
  const data = new Date(v.created_at || Date.now()).toISOString().slice(0, 10);
  const partes = [prefixo, v.claim_id ? `reclamacao_${v.claim_id}` : '', v.order_id ? `pedido_${v.order_id}` : '', data].filter(Boolean);
  const ext = MIMES[tipoBase(v.mime)] || path.extname(v.file_path || '').slice(1) || 'webm';
  return `${partes.join('_').replace(/[^a-zA-Z0-9_-]/g, '')}.${ext}`;
}

function enviarArquivo(res, filePath, { download, nome } = {}) {
  const abs = path.resolve(filePath);
  const fim = err => { if (err && !res.headersSent) res.status(404).json({ error: 'arquivo de vídeo não encontrado no disco' }); };
  if (download) return res.download(abs, nome, fim);
  res.sendFile(abs, fim);
}

// POST /api/devolucao-videos (multipart: return_id, duration_seconds,
// staff_user_name, observacao + arquivo `video`). Campos ANTES do arquivo no
// FormData, senão o multer ainda não tem return_id ao nomear o arquivo.
router.post('/', (req, res, next) => upload.single('video')(req, res, err => {
  if (!err) return next();
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Falha ao receber o vídeo: ' + err.message });
}), async (req, res) => {
  const f = req.file;
  try {
    if (!f) return res.status(400).json({ error: 'nenhum vídeo recebido' });
    const returnId = Number(req.body.return_id);
    const { rows: ret } = await pool.query(`SELECT id, order_id, claim_id FROM returns WHERE id = $1`, [returnId]);
    if (!ret.length) { await fsp.unlink(f.path).catch(() => {}); return res.status(404).json({ error: 'devolução não encontrada' }); }
    const dur = Number.parseInt(req.body.duration_seconds, 10);
    const { rows } = await pool.query(
      `INSERT INTO return_videos (return_id, order_id, claim_id, file_path, mime, file_size, duration_seconds, staff_user_name, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, return_id, created_at, mime, file_size, duration_seconds, staff_user_name, observacao`,
      [returnId, ret[0].order_id, ret[0].claim_id, f.path, tipoBase(f.mimetype), f.size,
       Number.isFinite(dur) && dur >= 0 ? dur : null,
       String(req.body.staff_user_name || '').slice(0, 80) || null,
       String(req.body.observacao || '').slice(0, 500) || null]
    );
    res.json({ ok: true, video: rows[0] });
  } catch (e) {
    console.error('[api/devolucao-videos] POST', e.message);
    if (f) await fsp.unlink(f.path).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// GET /api/devolucao-videos/por-devolucoes?return_ids=1,2,3 — lote (1
// chamada pra tabela inteira, sem N+1): { return_id: [vídeos, mais novo 1º] }.
router.get('/por-devolucoes', async (req, res) => {
  try {
    const ids = String(req.query.return_ids || '').split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    if (!ids.length) return res.json({});
    const { rows } = await pool.query(
      `SELECT id, return_id, created_at, mime, file_size, duration_seconds, staff_user_name, observacao
       FROM return_videos WHERE return_id = ANY($1::bigint[]) ORDER BY created_at DESC`,
      [ids]
    );
    const map = {};
    rows.forEach(r => { (map[r.return_id] = map[r.return_id] || []).push(r); });
    res.json(map);
  } catch (e) {
    console.error('[api/devolucao-videos] GET /por-devolucoes', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/devolucao-videos/:id/file[?download=1]
router.get('/:id(\\d+)/file', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM return_videos WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'vídeo não encontrado' });
    enviarArquivo(res, rows[0].file_path, { download: req.query.download === '1', nome: nomeDownload(rows[0]) });
  } catch (e) {
    console.error('[api/devolucao-videos] GET /:id/file', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/devolucao-videos/:id — gravação errada/de teste.
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM return_videos WHERE id = $1 RETURNING file_path`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'vídeo não encontrado' });
    await pool.query(`DELETE FROM video_links WHERE tipo = 'devolucao' AND video_id = $1`, [req.params.id]);
    await fsp.unlink(rows[0].file_path).catch(e => { if (e.code !== 'ENOENT') console.warn('[api/devolucao-videos] unlink', e.message); });
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/devolucao-videos] DELETE', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/devolucao-videos/link { tipo: 'devolucao'|'embalagem', id } →
// { token, path } do link público (reaproveita o token se já existe).
router.post('/link', async (req, res) => {
  try {
    const tipo = req.body && req.body.tipo, id = Number(req.body && req.body.id);
    const tabela = { devolucao: 'return_videos', embalagem: 'packing_videos' }[tipo];
    if (!tabela || !Number.isFinite(id)) return res.status(400).json({ error: 'tipo/id inválidos' });
    const existe = await pool.query(`SELECT 1 FROM ${tabela} WHERE id = $1`, [id]);
    if (!existe.rows.length) return res.status(404).json({ error: 'vídeo não encontrado' });
    const token = crypto.randomBytes(16).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO video_links (token, tipo, video_id) VALUES ($1, $2, $3)
       ON CONFLICT (tipo, video_id) DO UPDATE SET tipo = EXCLUDED.tipo RETURNING token`,
      [token, tipo, id]
    );
    res.json({ token: rows[0].token, path: `/api/publico/video/${rows[0].token}` });
  } catch (e) {
    console.error('[api/devolucao-videos] POST /link', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Público (sem login): GET /api/publico/video/:token[?download=1] ─────────
publicRouter.get('/:token([0-9a-f]{32})', async (req, res) => {
  try {
    const { rows: l } = await pool.query(`SELECT tipo, video_id FROM video_links WHERE token = $1`, [req.params.token]);
    if (!l.length) return res.status(404).send('Link de vídeo inválido ou expirado.');
    const tabela = l[0].tipo === 'devolucao' ? 'return_videos' : 'packing_videos';
    const { rows } = await pool.query(`SELECT * FROM ${tabela} WHERE id = $1`, [l[0].video_id]);
    if (!rows.length) return res.status(404).send('Este vídeo já foi apagado (prazo de guarda vencido).');
    const v = l[0].tipo === 'devolucao' ? rows[0]
      : { ...rows[0], order_id: (rows[0].order_ids || [])[0], mime: 'video/webm' };
    res.set('X-Robots-Tag', 'noindex');
    enviarArquivo(res, v.file_path, { download: req.query.download === '1', nome: nomeDownload(v, l[0].tipo) });
  } catch (e) {
    console.error('[api/publico/video]', e.message);
    res.status(500).send('Erro ao abrir o vídeo.');
  }
});

module.exports = { router, publicRouter, nomeDownload };
