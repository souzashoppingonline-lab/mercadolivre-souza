// Rotas do módulo FINANCEIRO — leem do Supabase separado (read-only), nunca do
// Postgres principal. Montadas em /api/financeiro (só admin — ver MODULES em
// routes/staffAuth.js). Ver .claude/modules.md.
const express = require('express');
const supa = require('../db/supabaseFin');

const router = express.Router();

// Status do módulo — a página usa pra saber se está configurado e conectado.
router.get('/status', async (req, res) => {
  try {
    res.json(await supa.ping());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista as tabelas do Supabase financeiro.
router.get('/tabelas', async (req, res) => {
  try {
    res.json({ tabelas: await supa.listTables() });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Prévia de linhas de uma tabela (read-only, no máx. 200).
router.get('/tabela/:nome', async (req, res) => {
  try {
    const rows = await supa.previewTable(req.params.nome, req.query.limit);
    res.json({ tabela: req.params.nome, total: Array.isArray(rows) ? rows.length : 0, rows });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Dados de uma tabela p/ as telas reais (read-only, limite maior, order opcional).
router.get('/dados/:nome', async (req, res) => {
  try {
    const rows = await supa.selectRows(req.params.nome, req.query.limit, req.query.order, req.query.filtro);
    res.json({ tabela: req.params.nome, total: Array.isArray(rows) ? rows.length : 0, rows });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Escrita (migração) — só tabelas da allowlist em supabaseFin (WRITE_ALLOW).
// Exige a chave service_role (sb_secret) no servidor; com a publishable falha.
function handleWriteErr(res, e) {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
  return res.status(e.status || 500).json({ error: e.message });
}
router.post('/dados/:nome', async (req, res) => {
  try { res.json({ rows: await supa.insertRow(req.params.nome, req.body) }); }
  catch (e) { handleWriteErr(res, e); }
});
router.patch('/dados/:nome/:id', async (req, res) => {
  try { res.json({ rows: await supa.updateRow(req.params.nome, req.params.id, req.body) }); }
  catch (e) { handleWriteErr(res, e); }
});
router.delete('/dados/:nome/:id', async (req, res) => {
  try { res.json({ rows: await supa.deleteRow(req.params.nome, req.params.id) }); }
  catch (e) { handleWriteErr(res, e); }
});

// ── Comprovante fiscal (arquivo) ────────────────────────────────────────────
// Upload em memória: o arquivo só passa por aqui a caminho do Storage do
// Supabase, não fica no disco do servidor (ao contrário do vídeo de embalagem,
// que é grande e mora local). 20 MB cobre PDF de nota e foto de comprovante.
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const EXT_OK = /\.(xml|pdf|png|jpe?g|webp)$/i;
const seguro = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80);

router.post('/arquivo', (req, res) => {
  upload.single('arquivo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 20 MB.' : err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'nenhum arquivo enviado' });
      if (!EXT_OK.test(req.file.originalname)) {
        return res.status(400).json({ error: 'formato não aceito — envie XML, PDF, PNG, JPG ou WEBP' });
      }
      // Caminho previsível e sem colisão: empresa/ano-mes/timestamp-nome.
      const empresa = seguro(req.body.empresa || 'sem-empresa');
      const comp = /^\d{4}-\d{2}$/.test(req.body.competencia || '') ? req.body.competencia : new Date().toISOString().slice(0, 7);
      const caminho = `${empresa}/${comp}/${Date.now()}-${seguro(req.file.originalname)}`;
      const gravado = await supa.uploadObject(caminho, req.file.buffer, req.file.mimetype);
      res.json({ path: gravado, nome: req.file.originalname, tamanho: req.file.size });
    } catch (e) { handleWriteErr(res, e); }
  });
});

// Download do comprovante. O bucket é privado — quem serve é o servidor, com a
// chave dele, atrás do gate de admin do módulo (ver MODULES em staffAuth).
router.get('/arquivo/:caminho(*)', async (req, res) => {
  try {
    const caminho = String(req.params.caminho || '');
    if (!caminho || caminho.includes('..')) return res.status(400).json({ error: 'caminho inválido' });
    const { buffer, contentType } = await supa.downloadObject(caminho);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${caminho.split('/').pop()}"`);
    res.send(buffer);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
