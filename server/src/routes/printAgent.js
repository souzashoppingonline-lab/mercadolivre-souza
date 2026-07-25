// Print Agent — rotas consumidas pelo agente que roda no PC da expedição.
// Montadas ANTES do gate de staff (requireStaffAuth) porque o agente é headless
// (sem cookie de sessão): a autenticação é por TOKEN de estação. Ver .claude/print-agent.md.
//
// Fluxo do agente: GET /jobs/next (reivindica 1 job) → GET /jobs/:id/pdf (baixa o
// PDF 10x15) → imprime na impressora USB → POST /jobs/:id/confirm (ou /error).
const express = require('express');
const pool = require('../db/pool');
const { generateLabelPDF } = require('../thermal/pdfLabel');

const router = express.Router();

// Auth por token de estação (header X-Station-Token ou ?token=). Atualiza last_seen
// (heartbeat) e injeta req.station. Sem token válido → 401.
async function requireStation(req, res, next) {
  try {
    const token = req.get('x-station-token') || req.query.token;
    if (!token) return res.status(401).json({ error: 'token de estação ausente' });
    const { rows } = await pool.query(
      `UPDATE print_stations SET last_seen = now() WHERE token = $1
       RETURNING id, name, store_id, printer_name`,
      [String(token)]
    );
    if (!rows.length) return res.status(401).json({ error: 'token de estação inválido' });
    req.station = rows[0];
    next();
  } catch (e) {
    console.error('[print-agent] auth', e.message);
    res.status(500).json({ error: e.message });
  }
}
router.use(requireStation);

// GET /print-agent/jobs/next — reivindica atomicamente 1 job pendente da estação
// (ou um "printing" preso há >2min, pra recuperar de agente que caiu). FOR UPDATE
// SKIP LOCKED garante que 2 instâncias do agente nunca peguem o mesmo job.
router.get('/jobs/next', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE print_jobs SET status='printing', claimed_at=now(), attempts=attempts+1
         WHERE id = (
           SELECT id FROM print_jobs
            WHERE station_id = $1
              AND (status='pending' OR (status='printing' AND claimed_at < now() - interval '2 minutes'))
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
       RETURNING id, shipping_id, label, attempts`,
      [req.station.id]
    );
    if (!rows.length) return res.json({ job: null });
    res.json({ job: rows[0], printer_name: req.station.printer_name });
  } catch (e) {
    console.error('[print-agent] GET /jobs/next', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /print-agent/jobs/:id/pdf — regenera o PDF 10x15 a partir do label do job
// (não guardamos PDF em disco). Só entrega se o job for da estação autenticada.
router.get('/jobs/:id/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT shipping_id, label FROM print_jobs WHERE id=$1 AND station_id=$2`,
      [req.params.id, req.station.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'job não encontrado para esta estação' });
    const l = rows[0].label || {};
    const pdf = await generateLabelPDF({
      shipping_id: rows[0].shipping_id,
      product_name: l.product_name || '(sem título)',
      variation_type: l.variation_type,
      sku: l.sku,
      store_name: l.store_name || '(sem loja)',
      company_name: l.company_name || 'EMPRESA XYZ',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiqueta-${rows[0].shipping_id || req.params.id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[print-agent] GET /jobs/:id/pdf', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /print-agent/jobs/:id/confirm — impresso com sucesso.
router.post('/jobs/:id/confirm', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE print_jobs SET status='printed', printed_at=now(), error=NULL
         WHERE id=$1 AND station_id=$2`,
      [req.params.id, req.station.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'job não encontrado para esta estação' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[print-agent] POST /jobs/:id/confirm', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /print-agent/jobs/:id/error — falha ao imprimir. Reagenda (volta a 'pending')
// até 3 tentativas; depois disso marca 'error' pra não ficar em loop.
router.post('/jobs/:id/error', async (req, res) => {
  try {
    const msg = String(req.body?.error || 'erro de impressão').slice(0, 500);
    const { rows } = await pool.query(
      `UPDATE print_jobs
          SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END,
              error = $3
        WHERE id=$1 AND station_id=$2
        RETURNING status`,
      [req.params.id, req.station.id, msg]
    );
    if (!rows.length) return res.status(404).json({ error: 'job não encontrado para esta estação' });
    res.json({ ok: true, status: rows[0].status });
  } catch (e) {
    console.error('[print-agent] POST /jobs/:id/error', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
