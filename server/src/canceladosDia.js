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

// Mesmo SELECT, 1 pedido (aviso na hora, v191). Sem o filtro de "do dia".
const SQL_UM = SQL.replace(/WHERE o\.status = 'cancelled' AND \(o\.date_created >= h\.ini OR o\.updated_at >= h\.ini\)/, "WHERE o.status = 'cancelled' AND o.ml_id = $1");

const BRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
const escH = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Texto do aviso NA HORA de 1 cancelamento (v191, pedido do usuário). `fatHoje` = faturamento de
// hoje já sem esta venda (mesma regra do placar). Puro — testado em test/canceladosDia.test.js.
function textoCanceladaNaHora(r, fatHoje = null) {
  const quando = new Date(r.date_created);
  const hora = quando.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const dia = quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `🚫 <b>Venda CANCELADA</b>\n`
    + `${r.mkt === 'SHOPEE' ? '🛍️ Shopee' : '🟡 ML'} · <b>${escH(r.loja)}</b> · vendida ${r.de_hoje ? `hoje às ${hora}` : `em ${dia} ${hora}`}\n`
    + `📦 ${escH(String(r.title || '—').slice(0, 80))} · ${Number(r.quantity) || 1} un · <b>${BRL(r.total_amount)}</b>\n`
    + (r.motivo ? `💬 ${escH(String(r.motivo).slice(0, 100))}\n` : '')
    + (r.bipado ? `⚠️ <b>JÁ FOI BIPADO/EMBALADO — tirar o pacote do envio, NÃO ENVIAR</b>\n` : '')
    + (r.de_hoje ? (fatHoje != null ? `💰 Saiu do faturamento de hoje → agora <b>${BRL(fatHoje)}</b>\n` : '💰 Saiu do faturamento de hoje\n')
                 : `📅 Saiu do faturamento do dia ${dia}\n`)
    + `🔖 ${escH(r.ml_id)}`;
}

// Avisa NA HORA (Telegram tg_vendas, aparece na Tela Telegram) um pedido que acabou de virar
// cancelado. Dedup no MESMO set da revisão de 3 h (cancelados:avisados:<dia>) — a revisão não
// repete como "novo". Só marca como avisado se o Telegram aceitou (silêncio → a revisão pega).
async function avisarCanceladaNaHora({ pool, redis, tgNotify, mlId }) {
  try {
    const { rows } = await pool.query(SQL_UM, [String(mlId)]);
    if (!rows.length) return false;
    const r = { ...rows[0], total_amount: Number(rows[0].total_amount) || 0 };
    const dia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const chave = `cancelados:avisados:${dia}`;
    if (await redis.sismember(chave, String(r.ml_id))) return false;
    const fatHoje = await pool.query(
      `SELECT COALESCE(SUM(o.total_amount), 0) AS fat FROM orders o LEFT JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.date_created >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.status != 'cancelled' AND COALESCE(m.code, 'ML') != 'AMAZON'`).then((x) => Number(x.rows[0].fat)).catch(() => null);
    if (!(await tgNotify('tg_vendas', textoCanceladaNaHora(r, fatHoje)))) return false;
    await redis.sadd(chave, String(r.ml_id));
    await redis.expire(chave, 2 * 86400);
    return true;
  } catch (e) { console.error('[cancelada-na-hora] erro:', e.message); return false; }
}

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

module.exports = { listarCanceladosHoje, resumir, textoCanceladaNaHora, avisarCanceladaNaHora, SQL_UM };
