// Rankeamento de anúncios — API de leitura/gestão da página pages/rankeamento.html.
// A lógica de notificação (venda/alteração/marco) vive em ../ranking.js e é
// disparada pelo worker; aqui só CRUD dos anúncios monitorados + timeline.
// Ver .claude/rankeamento.md.
const express = require('express');
const pool = require('../db/pool');
const ranking = require('../ranking');

const router = express.Router();
const MAX_ADS = 30; // trava de segurança: snapshot roda por anúncio ativo

// Lista os anúncios em rankeamento com estatísticas derivadas (ritmo, dias).
router.get('/ads', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, i.thumbnail, i.permalink, i.available_quantity AS estoque_atual,
              i.price AS preco_atual, i.status AS status_atual, s.nickname AS store_nickname,
              (SELECT COALESCE(SUM(o.unit_price * o.quantity), 0) FROM orders o
                 WHERE o.item_id = r.ml_id AND o.status <> 'cancelled' AND o.date_created >= r.started_at) AS faturamento
         FROM ranking_ads r
         LEFT JOIN items i ON i.ml_id = r.ml_id
         LEFT JOIN stores s ON s.id = r.store_id
        ORDER BY r.active DESC, r.last_sale_at DESC NULLS LAST, r.created_at DESC`
    );
    const now = Date.now();
    const ads = rows.map((r) => {
      const dias = r.first_sale_at ? Math.max(1, (now - new Date(r.first_sale_at).getTime()) / 86400000) : null;
      return { ...r, ritmo_dia: dias ? Number((r.sales_count / dias).toFixed(1)) : null, dias: dias ? Number(dias.toFixed(1)) : null };
    });
    res.json({ ads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Busca anúncios (items) para adicionar ao rankeamento — por ml_id ou título.
router.get('/buscar', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    // q vazio → lista os anúncios mais recentes (a "tabela com todos os anúncios").
    // Com q → filtra por ml_id/título. Marca quais já estão em rankeamento.
    const params = [];
    let where = `i.status <> 'closed'`;
    if (q.length >= 2) { params.push(`%${q}%`); where += ` AND (i.ml_id ILIKE $1 OR i.title ILIKE $1)`; }
    const { rows } = await pool.query(
      `SELECT i.ml_id, i.title, i.price, i.available_quantity, i.status, i.thumbnail, i.sold_quantity,
              s.nickname AS store_nickname,
              (r.id IS NOT NULL AND r.active) AS em_rankeamento
         FROM items i
         LEFT JOIN stores s ON s.id = i.store_id
         LEFT JOIN ranking_ads r ON r.ml_id = i.ml_id
        WHERE ${where}
        ORDER BY i.updated_at DESC LIMIT ${q.length >= 2 ? 30 : 100}`,
      params
    );
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marca um anúncio como "em rankeamento". Semeia os últimos valores conhecidos
// (preço/estoque/status) a partir de items, pra a 1ª alteração real não gerar
// alerta falso.
router.post('/ads', async (req, res) => {
  try {
    const mlId = String(req.body.ml_id || '').trim();
    if (!mlId) return res.status(400).json({ error: 'ml_id obrigatório' });
    const every = Number(req.body.milestone_every) > 0 ? Number(req.body.milestone_every) : 5;

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM ranking_ads WHERE active = true`);
    if (cnt.rows[0].n >= MAX_ADS) {
      return res.status(400).json({ error: `Limite de ${MAX_ADS} anúncios em rankeamento atingido. Desative algum antes de adicionar outro.` });
    }
    const { rows: it } = await pool.query(
      `SELECT ml_id, store_id, title, price, available_quantity, status FROM items WHERE ml_id = $1`, [mlId]
    );
    if (!it.length) return res.status(404).json({ error: 'Anúncio não encontrado no banco (ainda não sincronizado).' });
    const i = it[0];
    const { rows } = await pool.query(
      `INSERT INTO ranking_ads (ml_id, store_id, title, base_price, last_price, last_available_quantity, last_status, milestone_every, active, started_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,true, now())
       ON CONFLICT (ml_id) DO UPDATE SET active = true, milestone_every = EXCLUDED.milestone_every, updated_at = now()
       RETURNING *`,
      [i.ml_id, i.store_id, i.title, i.price, i.available_quantity, i.status, every]
    );
    res.json({ ad: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pausar/retomar ou mudar o intervalo do marco.
router.patch('/ads/:id', async (req, res) => {
  try {
    const sets = [], vals = [req.params.id]; let n = 1;
    if (req.body.active != null)          { sets.push(`active = $${++n}`); vals.push(!!req.body.active); }
    if (Number(req.body.milestone_every) > 0) { sets.push(`milestone_every = $${++n}`); vals.push(Number(req.body.milestone_every)); }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    sets.push('updated_at = now()');
    const { rows } = await pool.query(`UPDATE ranking_ads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    res.json({ ad: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove do rankeamento (apaga histórico de eventos via CASCADE).
router.delete('/ads/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ranking_ads WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Timeline de eventos de um anúncio (vendas + alterações + marcos), mais recentes primeiro.
router.get('/ads/:id/eventos', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const { rows } = await pool.query(
      `SELECT id, event_type, message, detail, created_at
         FROM ranking_events WHERE ranking_ad_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ eventos: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
