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

module.exports = router;
