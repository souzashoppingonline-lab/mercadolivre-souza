// Dashboard dedicado do TikTok Shop — 100% isolado do pipeline ML. Só lê
// orders filtrando marketplace_id=TIKTOK direto (não usa as views vw_ml_*
// nem nenhuma rota/query já existente para o ML). Mesmo padrão de
// routes/amazon.js/routes/shopee.js. Fase 1 (pedido explícito do usuário:
// "saber as vendas") — sem catálogo/chat/promoções/financeiro ainda, ver
// .claude/tiktok.md.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

async function tiktokMarketplaceId() {
  const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'TIKTOK'`);
  return rows[0]?.id || null;
}

router.get('/kpis', async (req, res) => {
  try {
    const mpId = await tiktokMarketplaceId();
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS pedidos_hoje,
         COALESCE(SUM(total_amount) FILTER (WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND status != 'cancelled'), 0) AS vendas_hoje,
         COUNT(*) FILTER (WHERE status != 'cancelled') AS pedidos_total,
         COALESCE(SUM(total_amount) FILTER (WHERE status != 'cancelled'), 0) AS vendas_total
       FROM orders WHERE marketplace_id = $1`,
      [mpId]
    );
    res.json({
      vendas_hoje: Number(rows[0]?.vendas_hoje || 0),
      pedidos_hoje: Number(rows[0]?.pedidos_hoje || 0),
      vendas_total: Number(rows[0]?.vendas_total || 0),
      pedidos_total: Number(rows[0]?.pedidos_total || 0),
    });
  } catch (e) {
    console.error('[api/tiktok] /kpis', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/pedidos', async (req, res) => {
  try {
    const mpId = await tiktokMarketplaceId();
    const { rows } = await pool.query(
      `SELECT o.ml_id AS id, o.total_amount AS valor, o.status, o.date_created AS data,
              s.nickname AS conta
       FROM orders o
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.marketplace_id = $1
       ORDER BY o.date_created DESC LIMIT 200`,
      [mpId]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/tiktok] /pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const mpId = await tiktokMarketplaceId();
    const { rows: syncRows } = await pool.query(
      `SELECT MAX(last_synced_at) AS ultima_sincronizacao FROM marketplace_sync_state WHERE marketplace_id = $1`,
      [mpId]
    );
    const { rows: storeRows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE refresh_token IS NOT NULL) AS conectadas, COUNT(*) AS total
       FROM stores WHERE marketplace_id = $1`,
      [mpId]
    );
    res.json({
      ultima_sincronizacao: syncRows[0]?.ultima_sincronizacao || null,
      contas_conectadas: Number(storeRows[0]?.conectadas || 0),
      contas_total: Number(storeRows[0]?.total || 0),
      ultimo_erro: null,
    });
  } catch (e) {
    console.error('[api/tiktok] /status', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
