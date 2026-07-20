// Dashboard dedicado da Shopee — 100% isolado do pipeline ML. Só lê
// orders/items filtrando marketplace_id=SHOPEE direto (não usa as views
// vw_ml_* nem nenhuma rota/query já existente para o ML). Mesmo padrão de
// routes/amazon.js. Ver pages/dashboard-shopee.html e .claude/shopee.md.
const express = require('express');
const pool = require('../db/pool');
const env = require('../config/env');
const { getShopeeClientForStore } = require('../marketplaces/shopee/shopeeClient');

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

// Lojas Shopee cadastradas — alimenta o seletor de loja das páginas (multi-loja)
// E a página "Lojas" (pages/shopee-lojas.html). Toda página nova filtra por
// store_id usando esta lista; sem store_id agrega tudo. Além dos campos base
// (id/nickname/shopee_shop_id/conectada, usados pelos seletores), traz métricas
// por loja pra tela de gestão: validade do token, última atualização, nº de
// pedidos, faturamento do mês e produtos ativos. Tudo por LEFT JOIN lateral
// filtrando marketplace_id=SHOPEE — nada compartilhado com o ML.
router.get('/lojas', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const { rows } = await pool.query(
      `SELECT s.id, s.nickname, s.shopee_shop_id,
              (s.refresh_token IS NOT NULL) AS conectada,
              s.token_expires_at,
              (s.token_expires_at IS NOT NULL AND s.token_expires_at > now()) AS token_valid,
              s.updated_at,
              COALESCE(o.total_pedidos, 0)   AS total_pedidos,
              COALESCE(o.faturamento_mes, 0) AS faturamento_mes,
              COALESCE(o.pedidos_mes, 0)     AS pedidos_mes,
              COALESCE(it.produtos_ativos, 0) AS produtos_ativos
       FROM stores s
       LEFT JOIN (
         SELECT store_id,
                COUNT(*) AS total_pedidos,
                COUNT(*) FILTER (WHERE date_created >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')) AS pedidos_mes,
                COALESCE(SUM(total_amount) FILTER (
                  WHERE status != 'cancelled'
                    AND date_created >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
                ), 0) AS faturamento_mes
         FROM orders WHERE marketplace_id = $1 GROUP BY store_id
       ) o ON o.store_id = s.id
       LEFT JOIN (
         SELECT store_id, COUNT(*) AS produtos_ativos
         FROM items WHERE marketplace_id = $1 AND status = 'active' GROUP BY store_id
       ) it ON it.store_id = s.id
       WHERE s.marketplace_id = $1 ORDER BY s.nickname`,
      [mpId]
    );
    res.json({ lojas: rows });
  } catch (e) {
    console.error('[api/shopee] /lojas', e.message);
    res.status(500).json({ error: e.message, lojas: [] });
  }
});

// Taxa efetiva REAL da Shopee, derivada do escrow dos pedidos (comissão que a
// Shopee já cobrou ÷ total pago pelo comprador). É a "taxa automática" do
// Precificador. Filtro opcional por loja. Retorna null se ainda não há escrow.
async function escrowFeePct(mpId, storeId) {
  const params = [mpId, storeId];
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(sod.commission_fee),0) AS com, COALESCE(SUM(sod.buyer_total),0) AS bt
     FROM shopee_order_data sod
     JOIN orders o ON o.ml_id = sod.order_id AND o.marketplace_id = $1
     WHERE ($2 = '' OR o.store_id = $2::bigint) AND sod.buyer_total > 0`,
    params
  );
  const com = Number(rows[0]?.com || 0);
  const bt = Number(rows[0]?.bt || 0);
  return bt > 0 ? (com / bt) * 100 : null;
}

// Precificador — itens+variações com custo (shopee_item_cost), preço atual e
// preço SUGERIDO por margem/taxa. Preço sugerido = (custo + taxa_fixa) /
// (1 - taxa% - margem%). Taxa% default = taxa efetiva do escrow (ou 14% se
// ainda não houver histórico). Só leitura (não grava — aplicar reusa /aplicar).
router.get('/precificador', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const storeId = req.query.store_id || '';
    const q = (req.query.q || '').trim();
    const margem = Number(req.query.margem);            // % desejada sobre o preço
    const taxaFixa = Number(req.query.taxa_fixa) || 0;  // R$ por venda
    const feeEscrow = await escrowFeePct(mpId, storeId);
    const taxaPct = req.query.taxa_pct != null && req.query.taxa_pct !== ''
      ? Number(req.query.taxa_pct)
      : (feeEscrow != null ? Number(feeEscrow.toFixed(2)) : 14);

    const params = [mpId, storeId];
    let qFilter = '';
    if (q) { params.push(`%${q}%`); qFilter = `AND (i.title ILIKE $${params.length} OR sid.item_sku ILIKE $${params.length})`; }
    const { rows } = await pool.query(
      `SELECT i.ml_id AS item_id, i.title, i.thumbnail, s.nickname AS conta,
              sid.item_sku, sid.has_model, sid.variation_count, sid.models
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
       LEFT JOIN shopee_item_data sid ON sid.item_id = i.ml_id
       WHERE i.marketplace_id = $1 AND ($2 = '' OR i.store_id = $2::bigint) ${qFilter}
       ORDER BY i.title LIMIT 500`,
      params
    );
    const { rows: costRows } = await pool.query(
      `SELECT sc.item_id, sc.model_id, sc.cost FROM shopee_item_cost sc
       JOIN items i ON i.ml_id = sc.item_id AND i.marketplace_id = $1`, [mpId]
    );
    const costMap = new Map(costRows.map((c) => [`${c.item_id}::${Number(c.model_id)}`, Number(c.cost)]));

    const denom = 1 - (taxaPct / 100) - (margem / 100);
    const calcSuggested = (cost) => (denom > 0 && cost != null) ? (Number(cost) + taxaFixa) / denom : null;
    const calcMargin = (price, cost) => {
      const p = Number(price);
      if (!p || cost == null) return null;
      const lucro = p - Number(cost) - (p * taxaPct / 100 + taxaFixa);
      return (lucro / p) * 100;
    };

    const out = rows.map((it) => {
      const models = (it.models && it.models.length) ? it.models : [{ model_id: 0, model_name: '—', current_price: null }];
      return {
        item_id: it.item_id, title: it.title, thumbnail: it.thumbnail, conta: it.conta,
        item_sku: it.item_sku, has_model: it.has_model, variation_count: it.variation_count,
        variacoes: models.map((m) => {
          const cost = costMap.has(`${it.item_id}::${Number(m.model_id || 0)}`) ? costMap.get(`${it.item_id}::${Number(m.model_id || 0)}`) : null;
          return {
            model_id: m.model_id || 0, model_name: m.model_name, model_sku: m.model_sku,
            cost, current_price: m.current_price ?? null,
            suggested_price: calcSuggested(cost),
            current_margin: calcMargin(m.current_price, cost),
          };
        }),
      };
    });
    res.json({ rows: out, taxa_pct: taxaPct, taxa_fixa: taxaFixa, margem, fee_escrow: feeEscrow });
  } catch (e) {
    console.error('[api/shopee] /precificador', e.message);
    res.status(500).json({ error: e.message, rows: [] });
  }
});

// Salvar o custo de uma variação (digitado no Precificador). Upsert por
// (item_id, model_id). Só aceita item de loja Shopee.
router.post('/custo', express.json(), async (req, res) => {
  try {
    const { item_id, model_id, cost } = req.body || {};
    if (!item_id) return res.status(400).json({ error: 'item_id é obrigatório' });
    const mpId = await shopeeMarketplaceId();
    const { rows } = await pool.query(`SELECT 1 FROM items WHERE ml_id = $1 AND marketplace_id = $2`, [String(item_id), mpId]);
    if (!rows.length) return res.status(404).json({ error: 'item Shopee não encontrado' });
    await pool.query(
      `INSERT INTO shopee_item_cost (item_id, model_id, cost, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (item_id, model_id) DO UPDATE SET cost = EXCLUDED.cost, updated_at = now()`,
      [String(item_id), Number(model_id || 0), Number(cost) || 0]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/shopee] /custo', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Itens Shopee com as variações (models) pra grade editável de Estoque & Preço.
// Lê do espelho local (shopee_item_data) — sem bater na Shopee (rápido). Filtro
// por loja e busca por título/SKU.
router.get('/estoque-preco', async (req, res) => {
  try {
    const mpId = await shopeeMarketplaceId();
    const storeId = req.query.store_id || '';
    const q = (req.query.q || '').trim();
    const params = [mpId, storeId];
    let qFilter = '';
    if (q) { params.push(`%${q}%`); qFilter = `AND (i.title ILIKE $${params.length} OR sid.item_sku ILIKE $${params.length})`; }
    const { rows } = await pool.query(
      `SELECT i.ml_id AS item_id, i.title, i.thumbnail, i.status, s.nickname AS conta,
              sid.item_sku, sid.has_model, sid.variation_count, sid.stock_total,
              sid.price_min, sid.price_max, sid.models
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
       LEFT JOIN shopee_item_data sid ON sid.item_id = i.ml_id
       WHERE i.marketplace_id = $1 AND ($2 = '' OR i.store_id = $2::bigint) ${qFilter}
       ORDER BY i.title LIMIT 500`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/shopee] /estoque-preco', e.message);
    res.status(500).json({ error: e.message, rows: [] });
  }
});

// Aplicar mudanças de preço/estoque em massa (Estoque & Preço). Recebe
// { changes: [{ item_id, model_id, price?, stock? }] } — grava na Shopee via
// update_price/update_stock (agrupando por item) e atualiza o espelho local
// (items + shopee_item_data.models). Retorna resultado por item. ESCRITA real —
// só afeta lojas Shopee (resolve store_id pelo item). Isolado do ML.
router.post('/anuncios/aplicar', express.json(), async (req, res) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ error: 'nenhuma mudança enviada' });

    const mpId = await shopeeMarketplaceId();
    // agrupa por item_id
    const byItem = new Map();
    for (const c of changes) {
      if (!c.item_id) continue;
      if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
      byItem.get(c.item_id).push(c);
    }

    const resultados = [];
    for (const [itemId, list] of byItem) {
      // resolve a loja dona do item (tem que ser Shopee)
      const { rows: ir } = await pool.query(
        `SELECT store_id FROM items WHERE ml_id = $1 AND marketplace_id = $2`, [String(itemId), mpId]
      );
      const storeId = ir[0]?.store_id;
      if (!storeId) { resultados.push({ item_id: itemId, ok: false, error: 'item não encontrado' }); continue; }

      let client;
      try { client = await getShopeeClientForStore(pool, storeId, env.shopee); }
      catch (e) { resultados.push({ item_id: itemId, ok: false, error: e.message }); continue; }

      const priceList = list.filter((c) => c.price != null && c.price !== '').map((c) => ({ model_id: c.model_id || 0, price: Number(c.price) }));
      const stockList = list.filter((c) => c.stock != null && c.stock !== '').map((c) => ({ model_id: c.model_id || 0, stock: Number(c.stock) }));

      try {
        if (priceList.length) await client.updatePrice(itemId, priceList);
        if (stockList.length) await client.updateStock(itemId, stockList);
      } catch (e) {
        resultados.push({ item_id: itemId, ok: false, error: e.message });
        continue;
      }

      // Atualiza o espelho local (models JSON + agregados em items/shopee_item_data).
      await updateLocalItemAfterWrite(itemId, storeId, priceList, stockList);
      resultados.push({ item_id: itemId, ok: true });
    }

    const okCount = resultados.filter((r) => r.ok).length;
    res.json({ ok: okCount === resultados.length, aplicados: okCount, total: resultados.length, resultados });
  } catch (e) {
    console.error('[api/shopee] /anuncios/aplicar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reflete no banco o que foi gravado na Shopee (evita esperar o próximo sync de
// 30min pra ver o novo valor). Atualiza models[] de shopee_item_data e reagrega
// price_min/max/stock_total + os campos de items.
async function updateLocalItemAfterWrite(itemId, storeId, priceList, stockList) {
  const { rows } = await pool.query(`SELECT models FROM shopee_item_data WHERE item_id = $1`, [String(itemId)]);
  let models = rows[0]?.models || [];
  const priceByModel = new Map(priceList.map((p) => [Number(p.model_id || 0), Number(p.price)]));
  const stockByModel = new Map(stockList.map((s) => [Number(s.model_id || 0), Number(s.stock)]));
  models = (models || []).map((m) => {
    const mid = Number(m.model_id || 0);
    return {
      ...m,
      current_price: priceByModel.has(mid) ? priceByModel.get(mid) : m.current_price,
      stock: stockByModel.has(mid) ? stockByModel.get(mid) : m.stock,
    };
  });
  const prices = models.map((m) => Number(m.current_price)).filter((n) => !Number.isNaN(n));
  const priceMin = prices.length ? Math.min(...prices) : null;
  const priceMax = prices.length ? Math.max(...prices) : null;
  const stockTotal = models.reduce((a, m) => a + (Number(m.stock) || 0), 0);
  await pool.query(
    `UPDATE shopee_item_data SET models = $2, price_min = $3, price_max = $4, stock_total = $5, updated_at = now() WHERE item_id = $1`,
    [String(itemId), JSON.stringify(models), priceMin, priceMax, stockTotal]
  );
  await pool.query(
    `UPDATE items SET price = $2, available_quantity = $3, updated_at = now() WHERE ml_id = $1`,
    [String(itemId), priceMin, stockTotal]
  );
}

// Renomear uma loja Shopee. O `nickname` é o nome exibido em TODAS as telas
// (chat/relatórios/vendas/financeiro leem `s.nickname AS conta`), então este é
// "o novo nome da loja". Só afeta lojas com marketplace_id=SHOPEE (isolado do
// ML). Nada de token/sync é tocado — nickname nunca é sobrescrito pelo worker.
router.patch('/lojas/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const nickname = (req.body?.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'nickname é obrigatório' });
    if (nickname.length > 80) return res.status(400).json({ error: 'nome muito longo (máx. 80 caracteres)' });

    const mpId = await shopeeMarketplaceId();
    const { rowCount } = await pool.query(
      `UPDATE stores SET nickname = $1, updated_at = now() WHERE id = $2 AND marketplace_id = $3`,
      [nickname, id, mpId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Loja Shopee não encontrada' });
    res.json({ ok: true, nickname });
  } catch (e) {
    console.error('[api/shopee] PATCH /lojas', e.message);
    res.status(500).json({ error: e.message });
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
      `SELECT i.ml_id AS item_id, sid.item_sku AS sku, i.title, i.available_quantity AS estoque,
              i.sold_quantity AS vendidos, i.price, i.status, i.thumbnail, i.category_id,
              s.nickname AS conta,
              sid.has_model, sid.variation_count, sid.price_min, sid.price_max
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
       LEFT JOIN shopee_item_data sid ON sid.item_id = i.ml_id
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
        ? 'Nenhum anúncio sincronizado ainda. O catálogo Shopee é sincronizado automaticamente pelo worker (job syncShopeeCatalog, a cada 30 min). Reinicie o ml-worker-novo e aguarde o 1º ciclo.'
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

// Chat — conversas Shopee não respondidas (unread_count > 0). Isolado.
// Preenchido pelo job syncShopeeChat (marketplaceEventWorker). store_id opcional.
router.get('/chat', async (req, res) => {
  try {
    const storeId = req.query.store_id || '';
    const { rows } = await pool.query(
      `SELECT c.conversation_id, c.buyer_name, c.unread_count, c.last_message,
              c.last_message_type, c.last_message_time, s.nickname AS conta
       FROM shopee_chat c LEFT JOIN stores s ON s.id = c.store_id
       WHERE ($2 = '1' OR c.unread_count > 0) AND ($1 = '' OR c.store_id = $1::bigint)
       ORDER BY c.last_message_time DESC NULLS LAST LIMIT 200`,
      [storeId, req.query.todas === '1' ? '1' : '0']
    );
    const totalNaoLidas = rows.reduce((a, r) => a + Number(r.unread_count || 0), 0);
    res.json({
      rows: rows.map((r) => ({
        conversation_id: r.conversation_id, buyer_name: r.buyer_name,
        unread_count: Number(r.unread_count || 0), last_message: r.last_message,
        last_message_type: r.last_message_type,
        // nanos → ms pro frontend formatar
        last_message_ms: r.last_message_time ? Math.round(Number(r.last_message_time) / 1e6) : null,
        conta: r.conta,
      })),
      resumo: { conversas: rows.length, nao_lidas: totalNaoLidas },
    });
  } catch (e) {
    console.error('[api/shopee] /chat', e.message);
    res.status(500).json({ error: e.message, rows: [], resumo: {} });
  }
});

// Histórico de UMA conversa (abrir o chat). Resolve a loja dona da conversa,
// constrói o client daquela conta (renova token se preciso) e busca as mensagens
// ao vivo na Shopee. `de` = 'comprador' | 'loja' (direção, calculada pelo to_id
// do comprador guardado em shopee_chat). Isolado do ML.
router.get('/chat/:conversationId/mensagens', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { rows } = await pool.query(
      `SELECT store_id, buyer_name, to_id FROM shopee_chat WHERE conversation_id = $1`,
      [conversationId]
    );
    const conv = rows[0];
    if (!conv || !conv.store_id) return res.status(404).json({ error: 'Conversa não encontrada', rows: [] });

    const client = await getShopeeClientForStore(pool, conv.store_id, env.shopee);
    const msgs = await client.getMessageList(conversationId, 30);
    const buyerId = conv.to_id != null ? String(conv.to_id) : null;
    // Shopee devolve as mensagens da mais nova pra mais antiga — invertemos pra
    // renderizar em ordem cronológica (como um chat).
    const ordered = [...(msgs || [])].reverse().map((m) => ({
      message_id: String(m.message_id || ''),
      de: buyerId && String(m.from_id) === buyerId ? 'comprador' : 'loja',
      tipo: m.message_type || 'text',
      texto: m.content?.text || (m.message_type && m.message_type !== 'text' ? `(${m.message_type})` : ''),
      // Shopee usa segundos aqui (created_timestamp) — normaliza pra ms.
      ts_ms: m.created_timestamp ? Number(m.created_timestamp) * 1000 : null,
    }));
    res.json({ buyer_name: conv.buyer_name, rows: ordered });
  } catch (e) {
    console.error('[api/shopee] /chat/mensagens', e.message);
    res.status(500).json({ error: e.message, rows: [] });
  }
});

// Responder o cliente DENTRO da plataforma (send_message). Resolve to_id + loja
// pela conversa, envia via client daquela conta e zera o unread localmente
// (some da lista de "não lidas" no próximo refresh). Pode exigir "Acesso a dados
// sensíveis" aprovado no console — se a Shopee recusar, devolve o erro pro front.
router.post('/chat/responder', express.json(), async (req, res) => {
  try {
    const { conversation_id, text } = req.body || {};
    if (!conversation_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: 'conversation_id e text são obrigatórios' });
    }
    const { rows } = await pool.query(
      `SELECT store_id, to_id FROM shopee_chat WHERE conversation_id = $1`,
      [conversation_id]
    );
    const conv = rows[0];
    if (!conv || !conv.store_id) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!conv.to_id) return res.status(422).json({ error: 'Sem o user_id do comprador nesta conversa ainda — aguarde o próximo sync do chat (até 10 min) e tente de novo.' });

    const client = await getShopeeClientForStore(pool, conv.store_id, env.shopee);
    await client.sendMessage(conv.to_id, String(text).trim());

    // Respondemos → não está mais "não lida". Atualiza o espelho local.
    await pool.query(
      `UPDATE shopee_chat SET unread_count = 0, last_message = $2, last_message_type = 'text', updated_at = now()
       WHERE conversation_id = $1`,
      [conversation_id, String(text).trim()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/shopee] /chat/responder', e.message);
    // Erros de negócio da Shopee (ex: falta de acesso sensível) chegam aqui com
    // a mensagem original — repassa pro usuário entender o motivo.
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
