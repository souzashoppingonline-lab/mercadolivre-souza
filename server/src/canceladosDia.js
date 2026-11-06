// Pedidos cancelados do dia (ML + Shopee, sem Amazon) — fonte única usada pelo
// worker (revisão a cada 3 h → Telegram, v171) e pela Tela Telegram (slide
// "Cancelados hoje", rota /api/telegram-tela/painel). Ver .claude/workers.md.
//
// "Do dia" = criado hoje OU que mudou hoje (updated_at) — pega também o pedido
// de ontem cancelado hoje. Dia no fuso America/Sao_Paulo.
// `de_hoje` diz se o pedido é de hoje: só esses saem do faturamento DE HOJE
// (o de outro dia sai do faturamento do dia em que foi vendido — o faturamento
// é sempre recalculado com status != 'cancelled', nada é guardado à parte).
const SQL = `
  WITH h AS (SELECT date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS ini)
  SELECT o.ml_id, o.title, o.quantity, COALESCE(o.total_amount, 0) AS total_amount, o.date_created,
         COALESCE(s.nickname, 'Loja ' || o.store_id) AS loja, COALESCE(m.code, 'ML') AS mkt,
         COALESCE(NULLIF(o.cancel_reason, ''), o.raw_data->'cancel_detail'->>'description', o.raw_data->>'cancel_reason') AS motivo,
         (o.date_created >= h.ini) AS de_hoje,
         EXISTS (SELECT 1 FROM packing_videos pv WHERE o.ml_id = ANY(pv.order_ids)) AS bipado
    FROM orders o
    CROSS JOIN h
    LEFT JOIN stores s ON s.id = o.store_id
    LEFT JOIN marketplaces m ON m.id = o.marketplace_id
   WHERE o.status = 'cancelled' AND (o.date_created >= h.ini OR o.updated_at >= h.ini)
     AND COALESCE(m.code, 'ML') != 'AMAZON'
   ORDER BY o.date_created`;

async function listarCanceladosHoje(pool) {
  const { rows } = await pool.query(SQL);
  return rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) || 0 }));
}

// Resumo pro painel/mensagem: total, valor, valor que saiu do faturamento de hoje, por loja.
function resumir(rows) {
  const porLoja = {};
  for (const r of rows) {
    const k = r.mkt + '|' + r.loja;   // mesma loja no ML e na Shopee = linhas separadas
    (porLoja[k] = porLoja[k] || { loja: r.loja, mkt: r.mkt, qtd: 0, valor: 0 });
    porLoja[k].qtd++; porLoja[k].valor += r.total_amount;
  }
  return {
    total: rows.length,
    valor: rows.reduce((a, r) => a + r.total_amount, 0),
    valor_fat_hoje: rows.filter((r) => r.de_hoje).reduce((a, r) => a + r.total_amount, 0),
    bipados: rows.filter((r) => r.bipado).length,
    por_loja: Object.values(porLoja).sort((a, b) => b.qtd - a.qtd || b.valor - a.valor),
  };
}

module.exports = { listarCanceladosHoje, resumir };
