// Dashboard dedicado da Shopee — 100% isolado do pipeline ML. Só lê
// orders/items filtrando marketplace_id=SHOPEE direto (não usa as views
// vw_ml_* nem nenhuma rota/query já existente para o ML). Mesmo padrão de
// routes/amazon.js. Ver pages/dashboard-shopee.html e .claude/shopee.md.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

async function shopeeMarketplaceId() {
  const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = 'SHOPEE'`);
  return rows[0]?.id || null;
}

router.get('/kpis', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS pedidos_hoje,
         COALESCE(SUM(total_amount) FILTER (WHERE (date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND status != 'cancelled'), 0) AS vendas_hoje
       FROM orders WHERE marketplace_id = $1`,
      [mpId]
    );
    const { rows: prodRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM items WHERE marketplace_id = $1 AND status = 'active'`,
      [mpId]
    );
    res.json({
      vendas_hoje: Number(rows[0]?.vendas_hoje || 0),
      pedidos_hoje: Number(rows[0]?.pedidos_hoje || 0),
      produtos_ativos: Number(prodRows[0]?.n || 0),
    });
  } catch (e) {
    console.error('[api/shopee] /kpis', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/pedidos', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const { rows } = await pool.query(
      `SELECT o.ml_id AS id, o.buyer_nickname AS cliente, o.item_id AS sku,
              o.total_amount AS valor, o.status, o.date_created AS data,
              s.nickname AS conta
       FROM orders o
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.marketplace_id = $1
       ORDER BY o.date_created DESC LIMIT 200`,
      [mpId]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/shopee] /pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/produtos', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    // Não há sync de catálogo Shopee ainda (Product API — ver .claude/todo.md),
    // então esta rota fica vazia com uma nota até isso ser implementado —
    // mesmo padrão de routes/amazon.js.
    const { status } = req.query;
    const params = [mpId];
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `AND status = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ml_id AS sku, title, available_quantity AS estoque, price, status
       FROM items WHERE marketplace_id = $1 ${statusFilter}
       ORDER BY updated_at DESC LIMIT 200`,
      params
    );
    res.json({
      rows,
      note: rows.length === 0
        ? 'Sincronização de catálogo de produtos da Shopee ainda não implementada — hoje só pedidos são sincronizados (ver .claude/todo.md).'
        : null,
    });
  } catch (e) {
    console.error('[api/shopee] /produtos', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
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
      // Sem tracking estruturado de erro de polling ainda — sempre null por ora.
      ultimo_erro: null,
    });
  } catch (e) {
    console.error('[api/shopee] /status', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
