// Módulo INTELIGÊNCIA DE NEGÓCIO (BI) — análises estratégicas sobre os dados
// OPERACIONAIS (Postgres principal). Montado em /api/bi (só admin — ver MODULES
// em routes/staffAuth.js). Distinto do Financeiro (que lê do Supabase).
// Amazon fica de fora dos números (sandbox/mock inflava) — ver dashboard/kpis.
// Ver .claude/modules.md.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// Painel Estratégico: um payload único com tudo que a home do BI usa.
// ?period = janela em dias (default 30); ?store_id opcional (filtra por loja).
router.get('/painel', async (req, res) => {
  try {
    const period = Math.min(Math.max(Number(req.query.period) || 30, 1), 365);
    const storeId = String(req.query.store_id || '').trim();
    const amazonId = (await pool.query(`SELECT id FROM marketplaces WHERE code='AMAZON'`)).rows[0]?.id || -1;

    // Datas em SP como EXPRESSÕES SQL inline (period é inteiro validado, seguro).
    const spToday = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
    const curIni = `(${spToday} - ${period - 1})`, curFim = `${spToday}`;
    const prevIni = `(${spToday} - ${2 * period - 1})`, prevFim = `(${spToday} - ${period})`;

    // Cláusula base compartilhada. $1 = amazonId; $2 = store_id (só se houver).
    // As datas entram inline (dIniExpr/dFimExpr são expressões SQL, não valores).
    const base = (dIniExpr, dFimExpr, alias = '') => {
      const p = alias ? alias + '.' : '';
      const params = [amazonId];
      let w = `${p}status <> 'cancelled'
               AND ${p}marketplace_id IS DISTINCT FROM $1
               AND (${p}date_created AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${dIniExpr} AND ${dFimExpr}`;
      if (storeId) { params.push(storeId); w += ` AND ${p}store_id = $${params.length}`; }
      return { w, params };
    };

    const kpiSql = (dIni, dFim) => {
      const { w, params } = base(dIni, dFim);
      return pool.query(
        `SELECT COUNT(*)::int pedidos, COALESCE(SUM(total_amount),0)::numeric receita,
                COALESCE(SUM(quantity),0)::int unidades
           FROM orders WHERE ${w}`, params);
    };

    const [cur, prev] = await Promise.all([kpiSql(curIni, curFim), kpiSql(prevIni, prevFim)]);

    // Série diária (período atual).
    const { w: wDia, params: pDia } = base(curIni, curFim);
    const diaria = await pool.query(
      `SELECT (date_created AT TIME ZONE 'America/Sao_Paulo')::date d,
              COUNT(*)::int pedidos, COALESCE(SUM(total_amount),0)::numeric receita
         FROM orders WHERE ${wDia}
        GROUP BY d ORDER BY d`, pDia);

    // Por canal (ML/Shopee) no período — orders com alias 'o' + join marketplaces.
    const { w: wCanal, params: pCanal } = base(curIni, curFim, 'o');
    const canais = await pool.query(
      `SELECT COALESCE(mk.code,'ML') code, COALESCE(mk.name,'Mercado Livre') name,
              COUNT(o.ml_id)::int pedidos, COALESCE(SUM(o.total_amount),0)::numeric receita
         FROM orders o LEFT JOIN marketplaces mk ON mk.id = o.marketplace_id
        WHERE ${wCanal}
        GROUP BY code, name ORDER BY receita DESC`, pCanal);

    // Top produtos por receita no período.
    const { w: wTop, params: pTop } = base(curIni, curFim);
    const top = await pool.query(
      `SELECT item_id, MAX(title) title, COUNT(*)::int pedidos,
              COALESCE(SUM(quantity),0)::int unidades, COALESCE(SUM(total_amount),0)::numeric receita
         FROM orders WHERE ${wTop} AND item_id IS NOT NULL
        GROUP BY item_id ORDER BY receita DESC LIMIT 10`, pTop);

    // Clientes novos vs recorrentes no período: "novo" = 1ª compra (histórica)
    // caiu dentro da janela; "recorrente" = já comprava antes.
    const { w: wCli, params: pCli } = base(curIni, curFim);
    const clientes = await pool.query(
      `WITH periodo AS (
         SELECT DISTINCT buyer_nickname FROM orders WHERE ${wCli} AND buyer_nickname IS NOT NULL
       )
       SELECT
         COUNT(*) FILTER (WHERE prim.primeira >= ${curIni})::int AS novos,
         COUNT(*) FILTER (WHERE prim.primeira <  ${curIni})::int AS recorrentes
       FROM periodo p
       JOIN LATERAL (
         SELECT MIN((o.date_created AT TIME ZONE 'America/Sao_Paulo')::date) primeira
           FROM orders o
          WHERE o.buyer_nickname = p.buyer_nickname AND o.status <> 'cancelled'
       ) prim ON true`, pCli);

    const n = v => Number(v) || 0;
    const growth = (a, b) => b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0);
    const c = cur.rows[0], pv = prev.rows[0];
    res.json({
      period,
      kpis: {
        receita: n(c.receita), pedidos: n(c.pedidos), unidades: n(c.unidades),
        ticket: n(c.pedidos) ? n(c.receita) / n(c.pedidos) : 0,
        receita_ant: n(pv.receita), pedidos_ant: n(pv.pedidos),
        cresc_receita: growth(n(c.receita), n(pv.receita)),
        cresc_pedidos: growth(n(c.pedidos), n(pv.pedidos)),
      },
      diaria: diaria.rows.map(r => ({ d: r.d, pedidos: n(r.pedidos), receita: n(r.receita) })),
      canais: canais.rows.map(r => ({ code: r.code, name: r.name, pedidos: n(r.pedidos), receita: n(r.receita) })),
      top: top.rows.map(r => ({ item_id: r.item_id, title: r.title, pedidos: n(r.pedidos), unidades: n(r.unidades), receita: n(r.receita) })),
      clientes: { novos: n(clientes.rows[0]?.novos), recorrentes: n(clientes.rows[0]?.recorrentes) },
    });
  } catch (e) {
    console.error('[bi] /painel error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
