// Rankeamento de anúncios novos — módulo central. Um anúncio marcado "em
// rankeamento" (ranking_ads) tem CADA venda e CADA alteração registrada em
// ranking_events e notificada na tela (WebSocket) + Telegram (tg_rankeamento).
// A cada N vendas (milestone_every, default 5) dispara um marco com resumo de
// ritmo. Ver .claude/rankeamento.md.
//
// Reaproveita notify.js (tgNotify) e ws/hub.js (publish) — as mesmas usadas
// pelo pipeline ML — então worker.js só chama onSale/onItemChange e não duplica
// lógica de Telegram/WS. mlClient é usado só no snapshot (visitas), nunca no bipe.
const pool = require('./db/pool');
const { tgNotify, tgNotifyForce } = require('./notify');
const { publish } = require('./ws/hub');

const BRL = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const fmtDT = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const linkOf = (mlId) => `https://www.mercadolivre.com.br/anuncios/${String(mlId).replace('MLB', 'MLB-')}`;

// Anúncio em rankeamento ATIVO (ou null). Consulta barata (índice único ml_id) —
// chamada nos handlers de venda/item; se o anúncio não está em rankeamento,
// retorna null e o handler segue normal, custo desprezível.
async function getTracked(mlId) {
  if (!mlId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM ranking_ads WHERE ml_id = $1 AND active = true`, [String(mlId)]
  );
  return rows[0] || null;
}

// Registra um evento (grava em ranking_events + notifica tela e Telegram).
// `force` usa tgNotifyForce (ignora silêncio/throttle) — para venda/marco, que
// devem SEMPRE acompanhar a venda no Telegram, logo depois do alerta normal.
async function emit(ad, eventType, message, detail = {}, force = false) {
  const { rows } = await pool.query(
    `INSERT INTO ranking_events (ranking_ad_id, ml_id, event_type, message, detail)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [ad.id, ad.ml_id, eventType, message, JSON.stringify(detail)]
  );
  const ev = rows[0];
  // Tela (dashboard) — consumido por pages/rankeamento.html e o sino do topbar.
  await publish('ranking_event', {
    ranking_ad_id: ad.id, ml_id: ad.ml_id, title: ad.title,
    event_type: eventType, message, detail, id: ev.id, created_at: ev.created_at,
  });
  // Telegram — tópico dedicado tg_rankeamento.
  if (force) await tgNotifyForce('tg_rankeamento', message);
  else await tgNotify('tg_rankeamento', message);
  return ev;
}

// Uma venda de um anúncio em rankeamento. `valorNum` é o valor da LINHA do
// pedido (unit_price × quantity) desse item, não o total do pedido.
async function onSale({ mlId, order, valorNum, comprador, saleDate }) {
  const ad = await getTracked(mlId);
  if (!ad) return;

  const now = new Date();
  const first = ad.first_sale_at || now;
  const { rows } = await pool.query(
    `UPDATE ranking_ads
       SET sales_count = sales_count + 1,
           first_sale_at = COALESCE(first_sale_at, $2),
           last_sale_at = $2,
           updated_at = now()
     WHERE id = $1
     RETURNING sales_count, first_sale_at`,
    [ad.id, now]
  );
  const count = rows[0].sales_count;
  const orderId = order?.id || order?.ml_id || '—';

  const every0 = ad.milestone_every || 5;
  const faltam = (every0 - (count % every0)) % every0;
  await emit(ad, 'venda',
    `🏆 <b>Venda de produto em rankeamento!</b>\n📦 ${ad.title || ad.ml_id}\n🔢 Venda nº <b>${count}</b> em rankeamento\n💰 ${BRL(valorNum)}\n👤 ${comprador || '—'}\n🕐 ${saleDate ? fmtDT(saleDate) : fmtDT(now)}\n🎯 ${faltam === 0 ? 'Marco atingido!' : `Faltam ${faltam} p/ o próximo marco (a cada ${every0})`}\n🔗 ${linkOf(ad.ml_id)}`,
    { order_id: orderId, valor: valorNum, comprador, sales_count: count }, true);

  // Marco a cada N vendas — resumo de ritmo.
  const every = ad.milestone_every || 5;
  if (count > 0 && count % every === 0) {
    await milestone({ ...ad, sales_count: count, first_sale_at: rows[0].first_sale_at });
  }
}

// Marco (a cada N vendas): total, tempo desde a 1ª venda, ritmo/dia e faturamento
// do anúncio no período em rankeamento.
async function milestone(ad) {
  const firstAt = ad.first_sale_at ? new Date(ad.first_sale_at) : new Date();
  const dias = Math.max(1, (Date.now() - firstAt.getTime()) / 86400000);
  const ritmo = (ad.sales_count / dias).toFixed(1);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(unit_price * quantity), 0) AS fat
       FROM orders
      WHERE item_id = $1 AND status <> 'cancelled'
        AND date_created >= $2`,
    [ad.ml_id, ad.started_at]
  );
  const fat = rows[0].fat;
  await emit(ad, 'marco',
    `🎯 <b>Marco: ${ad.sales_count} vendas em rankeamento</b>\n📦 ${ad.title || ad.ml_id}\n⏱️ ${dias.toFixed(1)} dia(s) desde a 1ª venda\n📈 Ritmo: ${ritmo} vendas/dia\n💵 Faturamento no período: ${BRL(fat)}\n🔗 ${linkOf(ad.ml_id)}`,
    { sales_count: ad.sales_count, dias: Number(dias.toFixed(1)), ritmo: Number(ritmo), faturamento: Number(fat) }, true);
}

// Alterações do anúncio detectadas no sync do item (handleItem) — preço, estoque
// e status. Zero custo de API: usa o item que o worker já buscou.
async function onItemChange({ mlId, price, availableQuantity, status, title }) {
  const ad = await getTracked(mlId);
  if (!ad) return;
  const sets = [], vals = [ad.id]; let updated = false;

  if (price != null && ad.last_price != null && Number(price) !== Number(ad.last_price)) {
    const dir = Number(price) > Number(ad.last_price) ? '⬆️ subiu' : '⬇️ baixou';
    await emit(ad, 'preco',
      `💲 <b>Preço ${dir}</b>\n📦 ${title || ad.title || ad.ml_id}\n${BRL(ad.last_price)} → <b>${BRL(price)}</b>`,
      { de: Number(ad.last_price), para: Number(price) });
    updated = true;
  }
  if (availableQuantity != null && ad.last_available_quantity != null && Number(availableQuantity) !== Number(ad.last_available_quantity)) {
    const zerou = Number(availableQuantity) === 0 ? '\n⚠️ <b>ESTOQUE ZERADO</b> — anúncio pode pausar e perder rankeamento!' : '';
    await emit(ad, 'estoque',
      `📦 <b>Estoque alterado</b>\n${title || ad.title || ad.ml_id}\n${ad.last_available_quantity} → <b>${availableQuantity}</b> un.${zerou}`,
      { de: Number(ad.last_available_quantity), para: Number(availableQuantity) });
    updated = true;
  }
  if (status && ad.last_status && status !== ad.last_status) {
    await emit(ad, 'status',
      `🚦 <b>Status do anúncio mudou</b>\n${title || ad.title || ad.ml_id}\n${ad.last_status} → <b>${status}</b>`,
      { de: ad.last_status, para: status });
    updated = true;
  }
  // Atualiza os últimos valores conhecidos sempre (mesmo sem evento, pra semear
  // a 1ª leitura de anúncios recém-marcados sem disparar alerta falso).
  await pool.query(
    `UPDATE ranking_ads
       SET last_price = COALESCE($2, last_price),
           last_available_quantity = COALESCE($3, last_available_quantity),
           last_status = COALESCE($4, last_status),
           updated_at = now()
     WHERE id = $1`,
    [ad.id, price ?? null, availableQuantity ?? null, status ?? null]
  );
  return updated;
}

// Snapshot periódico (job): pra cada anúncio ativo, coleta visitas (API) e lê
// qualidade (item_seo_score) e buy-box (catalog_competition) do banco, e notifica
// só quando muda. Rodado pelo worker (a cada 6h). Só os anúncios em rankeamento
// (poucos, limite de negócio) — não varre o catálogo todo, então não pesa no ML.
async function snapshot() {
  const ml = require('./mlClient'); // require tardio: evita custo se o job nunca roda
  const { rows: ads } = await pool.query(`SELECT * FROM ranking_ads WHERE active = true`);
  let checked = 0;
  for (const ad of ads) {
    try {
      // Visitas (últimos 1 dia) — best-effort.
      let visits = null;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const v = await ml.getItemVisits(ad.ml_id, today, ad.store_id);
        visits = v?.total_visits ?? (Array.isArray(v?.results) ? v.results.reduce((a, r) => a + (r.total || 0), 0) : null);
      } catch (_) { /* sem visitas agora */ }

      // Qualidade + buy-box do banco (jobs já populam essas tabelas).
      const { rows: q } = await pool.query(`SELECT score FROM item_seo_score WHERE item_id = $1`, [ad.ml_id]);
      const seo = q[0]?.score != null ? Number(q[0].score) : null;
      const { rows: c } = await pool.query(`SELECT winner_item_id, catalog_product_id FROM catalog_competition WHERE item_id = $1`, [ad.ml_id]);
      const buybox = c.length ? (String(c[0].winner_item_id) === String(ad.ml_id)) : null;

      // Posição nos "Mais Vendidos" da categoria (highlights). Casa por item id
      // (type ITEM) ou pelo catalog_product_id (type PRODUCT). null = fora do
      // ranking de destaque. best-effort (a API 404 se a categoria não tem highlights).
      let highlightPos = null;
      const { rows: cat } = await pool.query(`SELECT category_id FROM items WHERE ml_id = $1`, [ad.ml_id]);
      const categoryId = cat[0]?.category_id;
      if (categoryId) {
        try {
          const h = await ml.getCategoryHighlights(categoryId, ad.store_id);
          const prodId = c[0]?.catalog_product_id;
          const hit = (h?.content || []).find(x =>
            String(x.id) === String(ad.ml_id) || (prodId && String(x.id) === String(prodId)));
          highlightPos = hit ? Number(hit.position) : null;
        } catch (_) { /* categoria sem highlights */ }
      }

      if (visits != null && ad.last_visits != null && visits !== Number(ad.last_visits)) {
        const dir = visits > Number(ad.last_visits) ? '⬆️' : '⬇️';
        await emit(ad, 'visitas', `👁️ <b>Visitas ${dir}</b>\n📦 ${ad.title || ad.ml_id}\n${ad.last_visits} → <b>${visits}</b> (últ. dia)`, { de: Number(ad.last_visits), para: visits });
      }
      if (seo != null && ad.last_seo_score != null && seo !== Number(ad.last_seo_score)) {
        const dir = seo > Number(ad.last_seo_score) ? '⬆️ melhorou' : '⬇️ piorou';
        await emit(ad, 'qualidade', `⭐ <b>Qualidade ${dir}</b>\n📦 ${ad.title || ad.ml_id}\n${ad.last_seo_score} → <b>${seo}</b>`, { de: Number(ad.last_seo_score), para: seo });
      }
      if (buybox != null && ad.last_buybox != null && buybox !== ad.last_buybox) {
        await emit(ad, 'buybox', buybox
          ? `🥇 <b>GANHOU o buy-box!</b>\n📦 ${ad.title || ad.ml_id}`
          : `⚠️ <b>PERDEU o buy-box</b>\n📦 ${ad.title || ad.ml_id}`, { ganhando: buybox });
      }
      // Destaque nos Mais Vendidos: entrou / saiu / mudou de posição.
      if (highlightPos !== (ad.last_highlight_pos != null ? Number(ad.last_highlight_pos) : null)) {
        const antes = ad.last_highlight_pos;
        let msg;
        if (highlightPos != null && antes == null) msg = `🚀 <b>ENTROU nos Mais Vendidos!</b>\n📦 ${ad.title || ad.ml_id}\n🏅 Posição <b>#${highlightPos}</b> na categoria`;
        else if (highlightPos == null && antes != null) msg = `📉 <b>SAIU dos Mais Vendidos</b>\n📦 ${ad.title || ad.ml_id}\n(estava em #${antes})`;
        else { const dir = highlightPos < antes ? '⬆️ subiu' : '⬇️ caiu'; msg = `📊 <b>Mais Vendidos ${dir}</b>\n📦 ${ad.title || ad.ml_id}\n#${antes} → <b>#${highlightPos}</b> na categoria`; }
        await emit(ad, 'destaque', msg, { de: antes != null ? Number(antes) : null, para: highlightPos });
      }
      await pool.query(
        `UPDATE ranking_ads SET last_visits = COALESCE($2, last_visits),
           last_seo_score = COALESCE($3, last_seo_score),
           last_buybox = COALESCE($4, last_buybox),
           last_highlight_pos = $5, updated_at = now()
         WHERE id = $1`,
        [ad.id, visits, seo, buybox, highlightPos]
      );
      checked++;
    } catch (e) { console.error(`[ranking] snapshot ${ad.ml_id}:`, e.message); }
  }
  return { checked, total: ads.length };
}

module.exports = { getTracked, onSale, onItemChange, milestone, emit, snapshot, BRL, linkOf };
