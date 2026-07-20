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

// Lojas Shopee cadastradas — alimenta o seletor de loja das páginas (multi-loja).
// Toda página nova filtra por store_id usando esta lista; sem store_id agrega tudo.
router.get('/lojas', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const { rows } = await pool.query(
      `SELECT id, nickname, shopee_shop_id,
              (refresh_token IS NOT NULL) AS conectada
       FROM stores WHERE marketplace_id = $1 ORDER BY nickname`,
      [mpId]
    );
    res.json({ lojas: rows });
  } catch (e) {
    console.error('[api/shopee] /lojas', e.message);
    res.status(500).json({ error: e.message, lojas: [] });
  }
});

// Vendas Totais — agregados no período (default 30 dias), com filtro opcional
// por loja (store_id). Traz série por dia (gráfico), quebra por loja (multi-loja)
// e por status. Tudo lido de `orders` filtrando marketplace_id=SHOPEE.
router.get('/vendas', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const storeId = req.query.store_id || '';
    const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 30));
    // Filtro comum: marketplace + loja opcional + janela de N dias no fuso SP.
    const WHERE = `o.marketplace_id = $1 AND ($2 = '' OR o.store_id = $2::bigint)
      AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($3::int - 1)`;
    const params = [mpId, storeId, dias];

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
    const { rows: porLoja } = await pool.query(
      `SELECT o.store_id, s.nickname, s.shopee_shop_id,
              COUNT(*) AS pedidos,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS vendas
       FROM orders o LEFT JOIN stores s ON s.id = o.store_id
       WHERE ${WHERE} GROUP BY o.store_id, s.nickname, s.shopee_shop_id ORDER BY vendas DESC`,
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
      por_loja: porLoja.map((l) => ({ store_id: l.store_id, nickname: l.nickname, shopee_shop_id: l.shopee_shop_id, pedidos: Number(l.pedidos), vendas: Number(l.vendas) })),
      por_status: porStatus.map((s) => ({ status: s.status, pedidos: Number(s.pedidos), vendas: Number(s.vendas) })),
    });
  } catch (e) {
    console.error('[api/shopee] /vendas', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Anúncios (catálogo) — lê `items` de marketplace_id=SHOPEE, com filtro por loja
// e status. Hoje ainda não há sync de catálogo Shopee (Product API — ver
// .claude/todo.md), então vem vazio com uma nota; a estrutura já está pronta.
router.get('/anuncios', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const storeId = req.query.store_id || '';
    const status = req.query.status || '';
    const params = [mpId, storeId];
    let statusFilter = '';
    if (status) { params.push(status); statusFilter = `AND i.status = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT i.ml_id AS sku, i.title, i.available_quantity AS estoque,
              i.sold_quantity AS vendidos, i.price, i.status, s.nickname AS conta
       FROM items i LEFT JOIN stores s ON s.id = i.store_id
       WHERE i.marketplace_id = $1 AND ($2 = '' OR i.store_id = $2::bigint) ${statusFilter}
       ORDER BY i.updated_at DESC LIMIT 500`,
      params
    );
    const { rows: resumoRows } = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'active') AS ativos,
              COUNT(*) FILTER (WHERE status = 'paused') AS pausados,
              COALESCE(SUM(available_quantity), 0) AS estoque_total
       FROM items WHERE marketplace_id = $1 AND ($2 = '' OR store_id = $2::bigint)`,
      [mpId, storeId]
    );
    res.json({
      rows,
      resumo: resumoRows[0] || { total: 0, ativos: 0, pausados: 0, estoque_total: 0 },
      note: rows.length === 0
        ? 'Sincronização de catálogo de produtos da Shopee ainda não implementada — hoje só pedidos são sincronizados (ver .claude/todo.md). A estrutura da página já está pronta para quando a Product API for integrada.'
        : null,
    });
  } catch (e) {
    console.error('[api/shopee] /anuncios', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Financeiro (repasse/escrow) — quanto líquido cai por pedido, taxa Shopee e
// status de entrega. Isolado da Conciliação Bancária do ML (pedido do usuário:
// tudo Shopee separado). Lê shopee_order_data (preenchido pelo worker via
// get_escrow_detail/get_tracking_info). store_id opcional + período em dias.
router.get('/financeiro', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const storeId = req.query.store_id || '';
    const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 30));
    const params = [mpId, storeId, dias];
    const WHERE = `o.marketplace_id = $1 AND ($2 = '' OR o.store_id = $2::bigint)
      AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($3::int - 1)`;

    const { rows } = await pool.query(
      `SELECT o.ml_id AS order_sn, o.date_created, o.status, s.nickname AS conta,
              sod.buyer_total, sod.commission_fee, sod.escrow_amount,
              sod.buyer_payment_method, sod.logistics_status, sod.tracking_number,
              -- frete vem do escrow_raw (order_income): não precisou de coluna nova
              (sod.escrow_raw->'order_income'->>'buyer_paid_shipping_fee')::numeric AS frete_comprador,
              (sod.escrow_raw->'order_income'->>'actual_shipping_fee')::numeric AS frete_real
       FROM orders o
       JOIN shopee_order_data sod ON sod.order_sn = o.ml_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE ${WHERE}
       ORDER BY o.date_created DESC LIMIT 500`,
      params
    );
    const { rows: resumo } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE sod.escrow_amount IS NOT NULL) AS com_escrow,
              COALESCE(SUM(sod.buyer_total), 0) AS bruto,
              COALESCE(SUM(sod.commission_fee), 0) AS comissao,
              COALESCE(SUM(sod.escrow_amount), 0) AS liquido,
              COALESCE(SUM((sod.escrow_raw->'order_income'->>'buyer_paid_shipping_fee')::numeric), 0) AS frete
       FROM orders o JOIN shopee_order_data sod ON sod.order_sn = o.ml_id
       WHERE ${WHERE}`,
      params
    );
    const r = resumo[0] || {};
    res.json({
      rows: rows.map((x) => ({
        order_sn: x.order_sn, data: x.date_created, status: x.status, conta: x.conta,
        buyer_total: x.buyer_total != null ? Number(x.buyer_total) : null,
        commission_fee: x.commission_fee != null ? Number(x.commission_fee) : null,
        escrow_amount: x.escrow_amount != null ? Number(x.escrow_amount) : null,
        buyer_payment_method: x.buyer_payment_method, logistics_status: x.logistics_status,
        tracking_number: x.tracking_number,
        frete: x.frete_comprador != null ? Number(x.frete_comprador) : null,
        frete_real: x.frete_real != null ? Number(x.frete_real) : null,
      })),
      resumo: {
        com_escrow: Number(r.com_escrow || 0),
        bruto: Number(r.bruto || 0),
        comissao: Number(r.comissao || 0),
        liquido: Number(r.liquido || 0),
        frete: Number(r.frete || 0),
        dias,
      },
    });
  } catch (e) {
    console.error('[api/shopee] /financeiro', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
