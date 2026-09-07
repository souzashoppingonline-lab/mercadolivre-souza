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

// Vendas Totais — mesmo padrão exato de routes/shopee.js GET /vendas
// (resumo + série diária + por status), sem seletor de loja: local seller
// só tem 1 loja TikTok Shop por região (confirmado na doc oficial, ver
// .claude/tiktok.md "Seller API overview" / probation), então agregar por
// loja não agrega valor aqui como agrega na Shopee (múltiplas contas).
// Usada por pages/tiktok-vendas.html — tela real de teste pro revisor do
// TikTok Shop Partner Center (pedido do usuário: "algo pra testar", sem
// dado inventado — vem vazio até haver pedido real sincronizado).
router.get('/vendas', async (req, res) => {
  try {
    const mpId = await tiktokMarketplaceId();
    const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 30));
    const WHERE = `o.marketplace_id = $1
      AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($2::int - 1)`;
    const params = [mpId, dias];

    const { rows: resumoRows } = await pool.query(
      `SELECT COUNT(*) AS pedidos,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS vendas,
              COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelados,
              COUNT(*) FILTER (WHERE (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS pedidos_hoje,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled' AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS vendas_hoje
       FROM orders o WHERE ${WHERE}`,
      params
    );
    const { rows: porDia } = await pool.query(
      `SELECT (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
              COUNT(*) AS pedidos,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS vendas
       FROM orders o WHERE ${WHERE} GROUP BY 1 ORDER BY 1`,
      params
    );
    const { rows: porStatus } = await pool.query(
      `SELECT o.status, COUNT(*) AS pedidos, COALESCE(SUM(o.total_amount), 0) AS vendas
       FROM orders o WHERE ${WHERE} GROUP BY o.status ORDER BY pedidos DESC`,
      params
    );

    const r0 = resumoRows[0] || {};
    const pedidosValidos = Number(r0.pedidos || 0) - Number(r0.cancelados || 0);
    res.json({
      resumo: {
        vendas: Number(r0.vendas || 0),
        pedidos: Number(r0.pedidos || 0),
        cancelados: Number(r0.cancelados || 0),
        ticket_medio: pedidosValidos > 0 ? Number(r0.vendas || 0) / pedidosValidos : 0,
        vendas_hoje: Number(r0.vendas_hoje || 0),
        pedidos_hoje: Number(r0.pedidos_hoje || 0),
        dias,
      },
      por_dia: porDia.map((d) => ({ dia: d.dia, pedidos: Number(d.pedidos), vendas: Number(d.vendas) })),
      por_status: porStatus.map((s) => ({ status: s.status, pedidos: Number(s.pedidos), vendas: Number(s.vendas) })),
    });
  } catch (e) {
    console.error('[api/tiktok] /vendas', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Anúncios (catálogo) — mesmo padrão exato de routes/amazon.js GET /produtos.
// Não há sync de catálogo TikTok Shop ainda (Fase 1 é só pedidos, Product
// API fica pra uma fase futura, ver .claude/tiktok.md) — vem vazio com uma
// nota explicando isso, nunca dado inventado. A estrutura já fica pronta
// pro dia em que o catálogo for sincronizado.
router.get('/produtos', async (req, res) => {
  try {
    const mpId = await tiktokMarketplaceId();
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
        ? 'Sincronização de catálogo de produtos do TikTok Shop ainda não implementada — hoje só pedidos são sincronizados (Fase 1, ver .claude/tiktok.md).'
        : null,
    });
  } catch (e) {
    console.error('[api/tiktok] /produtos', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
