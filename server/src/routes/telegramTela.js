// Tela Telegram (TV) — mensagens copiadas em telegram_mensagens
// (telegramLog.js). Duas portas pro mesmo dado:
//  • /api/telegram-tela          → com login (gate normal de /api)
//  • /api/publico/telegram-tela  → link da TV, com ?token= (app_config
//    telegram_tela_token, 32 hex). A TV não precisa de usuário/senha nem cai
//    a sessão. "Gerar novo link" troca o token e o link antigo para de valer.
// GET ?depois_id=N → só as mais novas (a tela pergunta a cada 15s e quando o
// WebSocket avisa `telegram_mensagem`); sem depois_id → as últimas `limit`.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { cached } = require('../db/cached');
const { classificar: classificarBuybox } = require('../../../js/buyboxStatus');

const router = express.Router();
const publicRouter = express.Router();

// Tópicos que NÃO aparecem na tela (pedido do usuário: contas pagas/a pagar
// ficam só no Telegram — a TV fica num lugar onde todos veem). Continuam
// sendo gravados em telegram_mensagens; só não saem nesta API (nem no link da TV).
const FORA_DA_TELA = ['tg_pagamentos', 'tg_dividas_lembrete'];

async function listar(req, res) {
  try {
    const depois = Number(req.query.depois_id) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
    const { rows } = depois
      ? await pool.query(`SELECT id, topico, texto, html, direcao, autor, imagem, criado_em FROM telegram_mensagens WHERE id > $1 AND COALESCE(topico, '') <> ALL($3::text[]) ORDER BY id ASC LIMIT $2`, [depois, limit, FORA_DA_TELA])
      : await pool.query(`SELECT * FROM (SELECT id, topico, texto, html, direcao, autor, imagem, criado_em FROM telegram_mensagens WHERE COALESCE(topico, '') <> ALL($2::text[]) ORDER BY id DESC LIMIT $1) x ORDER BY id ASC`, [limit, FORA_DA_TELA]);
    const { rows: h } = await pool.query(`SELECT COUNT(*)::int AS n FROM telegram_mensagens WHERE criado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AND COALESCE(topico, '') <> ALL($1::text[])`, [FORA_DA_TELA]);
    res.json({ mensagens: rows, hoje: h[0].n });
  } catch (e) {
    console.error('[api/telegram-tela]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function tokenTv(novo) {
  if (!novo) {
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key = 'telegram_tela_token'`);
    if (rows[0] && /^[0-9a-f]{32}$/.test(rows[0].value)) return rows[0].value;
  }
  const t = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('telegram_tela_token', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [t]);
  return t;
}

// ── Painel ao lado das mensagens (v124): placar de hoje, rankeamento hoje
// (vendas por estágio + placar de Buy Box) e as 3 ações mais urgentes da IA
// Estrategista. Cache 20s (a tela pede a cada 1 min e logo depois de cada
// mensagem nova). Pedidos: mesma regra do "Vendas hoje" do painel principal
// (kpis:summary — orders, sem cancelados, ML + Shopee, sem Amazon).
// v140 — Ritmo de vendas (puro): "1 venda a cada X min" hoje × ontem até a mesma
// hora, última hora × mesma hora de ontem, e o maior intervalo sem venda (entre
// vendas, ou da última venda até agora — `aberto`). Intervalo só conta a partir
// das 6h (madrugada sem venda é normal); o trecho antes da 1ª venda não conta.
function calcularRitmo(vendasMs, agora) {
  const iniHoje = new Date(new Date(agora).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  iniHoje.setHours(0, 0, 0, 0);
  const deslocamento = new Date(new Date(agora).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getTime() - agora;
  const h0 = iniHoje.getTime() - deslocamento, o0 = h0 - 86400000, oAgora = agora - 86400000;
  const lado = (ini, fim) => {
    const xs = vendasMs.filter(t => t >= ini && t <= fim);
    const min = (fim - ini) / 60000, ult = xs.filter(t => t > fim - 3600000).length;
    let gap = null;
    const seis = ini + 6 * 3600000;
    for (let k = 1; k <= xs.length; k++) {
      const a = Math.max(xs[k - 1], seis), b = k < xs.length ? xs[k] : fim;
      if (b <= a) continue;
      if (!gap || b - a > gap.fim - gap.ini) gap = { ini: a, fim: b, aberto: k === xs.length };
    }
    return { pedidos: xs.length, min_por_venda: xs.length ? min / xs.length : null, ultima_hora: ult,
      maior_gap: gap ? { ini: new Date(gap.ini).toISOString(), fim: new Date(gap.fim).toISOString(), min: Math.round((gap.fim - gap.ini) / 60000), aberto: gap.aberto } : null };
  };
  return { hoje: lado(h0, agora), ontem: lado(o0, oAgora) };
}

async function montarPainel() {
  const redis = require('../db/redis');
  const [{ rows: tot }, { rows: lojas }, { rows: est }, { rows: bb }, { rows: rec }, { rows: tokens }, { rows: ult }, hbWorker] = await Promise.all([
    pool.query(
      `WITH l AS (SELECT date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS ini)
       SELECT COUNT(*) FILTER (WHERE o.date_created >= l.ini)::int AS pedidos_hoje,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created >= l.ini), 0) AS fat_hoje,
              COUNT(*) FILTER (WHERE o.date_created < l.ini AND o.date_created < now() - interval '1 day')::int AS pedidos_ontem,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created < l.ini AND o.date_created < now() - interval '1 day'), 0) AS fat_ontem,
              COUNT(*) FILTER (WHERE o.date_created < l.ini)::int AS pedidos_ontem_dia,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created < l.ini), 0) AS fat_ontem_dia
         FROM orders o, l
        WHERE o.date_created >= l.ini - interval '1 day' AND o.status != 'cancelled'
          AND o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')`),
    pool.query(
      `SELECT COALESCE(s.nickname, 'Loja ' || o.store_id) AS loja, COALESCE(m.code, 'ML') AS mkt,
              COUNT(*)::int AS pedidos, COALESCE(SUM(o.total_amount), 0) AS fat
         FROM orders o
         LEFT JOIN stores s ON s.id = o.store_id
         LEFT JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.date_created >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.status != 'cancelled' AND COALESCE(m.code, 'ML') != 'AMAZON'
        GROUP BY 1, 2 ORDER BY fat DESC LIMIT 8`),
    pool.query(
      `SELECT COALESCE(e.detail->>'fase', a.fase, 'rankeando') AS fase, COUNT(*)::int AS vendas
         FROM ranking_events e JOIN ranking_ads a ON a.id = e.ranking_ad_id
        WHERE e.event_type = 'venda'
          AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
        GROUP BY 1`),
    pool.query(
      `SELECT cc.item_id, cc.status, cc.winner_item_id, cc.calculated_at, cc.current_price, cc.winner_price,
              COALESCE(i.title, cc.item_id) AS titulo, s.nickname AS loja
         FROM catalog_competition cc LEFT JOIN items i ON i.ml_id = cc.item_id LEFT JOIN stores s ON s.id = cc.store_id
        WHERE i.status IS NULL OR i.status = 'active'`),
    // Recorde do mês: maior dia de faturamento ANTES de hoje (mesma regra de pedidos).
    pool.query(
      `SELECT (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia, SUM(o.total_amount) AS fat
         FROM orders o
        WHERE o.date_created >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.date_created < date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.status != 'cancelled'
          AND o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1`),
    // Saúde: tokens das lojas do MERCADO LIVRE (o tokenRefreshLoop do worker renova antes de vencer —
    // vencido aqui = refresh falhou / reconexão necessária). Shopee/TikTok renovam sob demanda: ficam de fora (alarme falso).
    pool.query(`SELECT nickname, token_expires_at FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') ORDER BY nickname`),
    pool.query(
      `SELECT MAX(date_created) AS ultima FROM orders
        WHERE status != 'cancelled' AND date_created > now() - interval '7 days'
          AND marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')`),
    redis.get('health:hb:worker').catch(() => null), // heartbeat do worker (health.js)
  ]);
  // ── Carrossel (v129): mais vendidos hoje, vendas por hora, estoque em risco ──
  const [{ rows: topHoje }, { rows: porHora }, { rows: estoqueRisco }, { rows: topSemana }, { rows: promoMl }, { rows: promoShopee }, { rows: pertoMarco }] = await Promise.all([
    pool.query(
      `SELECT o.item_id, MAX(COALESCE(i.title, o.title)) AS titulo, MAX(i.thumbnail) AS thumb, MAX(COALESCE(s.nickname, '')) AS loja,
              COUNT(*)::int AS pedidos, COALESCE(SUM(o.quantity), 0)::int AS unidades, COALESCE(SUM(o.total_amount), 0) AS fat
         FROM orders o LEFT JOIN items i ON i.ml_id = o.item_id LEFT JOIN stores s ON s.id = o.store_id
        WHERE o.date_created >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.status != 'cancelled'
          AND o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')
        GROUP BY o.item_id ORDER BY fat DESC LIMIT 6`),
    pool.query(
      `WITH l AS (SELECT date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS ini)
       SELECT EXTRACT(HOUR FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS h,
              COUNT(*) FILTER (WHERE o.date_created >= l.ini)::int AS hoje,
              COUNT(*) FILTER (WHERE o.date_created < l.ini)::int AS ontem
         FROM orders o, l
        WHERE o.date_created >= l.ini - interval '1 day' AND o.status != 'cancelled'
          AND o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')
        GROUP BY 1`),
    // Estoque em risco: ativo, ≤ 5 un (mesmo limiar do alerta tg_reposicao) e vendeu nos últimos 7 dias.
    pool.query(
      `SELECT i.ml_id, i.title AS titulo, i.available_quantity AS estoque, s.nickname AS loja, COUNT(o.ml_id)::int AS vendas7
         FROM items i
         JOIN orders o ON o.item_id = i.ml_id AND o.status != 'cancelled' AND o.date_created >= now() - interval '7 days'
         LEFT JOIN stores s ON s.id = i.store_id
        WHERE i.status = 'active' AND i.available_quantity <= 5
        GROUP BY i.ml_id, i.title, i.available_quantity, s.nickname
        ORDER BY i.available_quantity ASC, vendas7 DESC LIMIT 6`),
    // v131 — Mais vendidos da semana (7 dias até agora) × 7 dias anteriores.
    pool.query(
      `SELECT o.item_id, MAX(COALESCE(i.title, o.title)) AS titulo, MAX(i.thumbnail) AS thumb, MAX(COALESCE(s.nickname, '')) AS loja,
              COUNT(*) FILTER (WHERE o.date_created >= now() - interval '7 days')::int AS pedidos,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created >= now() - interval '7 days'), 0) AS fat,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created < now() - interval '7 days'), 0) AS fat_ant
         FROM orders o LEFT JOIN items i ON i.ml_id = o.item_id LEFT JOIN stores s ON s.id = o.store_id
        WHERE o.date_created >= now() - interval '14 days' AND o.status != 'cancelled'
          AND o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')
        GROUP BY o.item_id HAVING SUM(o.total_amount) FILTER (WHERE o.date_created >= now() - interval '7 days') > 0
        ORDER BY fat DESC LIMIT 5`),
    // v131 — Promoções ML ativas: último status de cada oferta (tabela promotions é histórico).
    // Data de fim: só se o ML mandou no payload da oferta (vários formatos possíveis).
    pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (p.offer_id) p.offer_id, p.item_id, COALESCE(p.item_title, i.title) AS titulo, p.status, s.nickname AS loja,
                p.promo_price, p.discount_pct,
                COALESCE(p.raw_data->>'end_date', p.raw_data->>'finish_date', p.raw_data->'offers'->0->>'end_date', p.raw_data->'offers'->0->>'finish_date') AS fim
           FROM promotions p LEFT JOIN items i ON i.ml_id = p.item_id LEFT JOIN stores s ON s.id = p.store_id
          WHERE p.changed_at >= now() - interval '90 days'
          ORDER BY p.offer_id, p.changed_at DESC) x
        WHERE status IN ('active', 'started')`),
    pool.query(
      `SELECT sp.name, sp.desconto, sp.end_time, s.nickname AS loja FROM shopee_promotions sp LEFT JOIN stores s ON s.id = sp.store_id
        WHERE sp.status = 'ongoing' ORDER BY sp.end_time`),
    // v131 — Rankeamento: anúncios a 1 ou 2 vendas do próximo marco.
    pool.query(
      `SELECT ra.id, ra.ml_id, COALESCE(i.title, ra.title) AS titulo, ra.fase, ra.sales_count, COALESCE(ra.milestone_every, 5) AS every,
              COALESCE(ra.milestone_every, 5) - (ra.sales_count % COALESCE(ra.milestone_every, 5)) AS faltam
         FROM ranking_ads ra LEFT JOIN items i ON i.ml_id = ra.ml_id
        WHERE ra.active = true AND ra.sales_count > 0
          AND COALESCE(ra.milestone_every, 5) - (ra.sales_count % COALESCE(ra.milestone_every, 5)) <= 2
        ORDER BY faltam, ra.last_sale_at DESC NULLS LAST LIMIT 6`),
  ]);
  // ── v133: equipe (bipados), ticket, estados, parados, voltaram, reputação, recorrentes ──
  const HOJE = `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
  const SEM_AMAZON = `o.marketplace_id IS DISTINCT FROM (SELECT id FROM marketplaces WHERE code = 'AMAZON')`;
  const [{ rows: bipHoje }, { rows: ticket }, { rows: estados }, { rows: parados }, { rows: voltaram }, { rows: reput }, { rows: recorr }] = await Promise.all([
    // Pedidos bipados hoje (vídeo de embalagem gravado) — total e por embalador.
    pool.query(
      `SELECT COALESCE(NULLIF(staff_user_name, ''), 'Sem login') AS nome, COUNT(*)::int AS envios,
              COALESCE(SUM(cardinality(order_ids)), 0)::int AS pedidos
         FROM packing_videos WHERE created_at >= ${HOJE}
        GROUP BY 1 ORDER BY pedidos DESC`),
    // Ticket médio e unidades por pedido: hoje × ontem até o mesmo horário.
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE o.date_created >= ${HOJE})::int AS ped_h,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created >= ${HOJE}), 0) AS fat_h,
              COALESCE(SUM(o.quantity) FILTER (WHERE o.date_created >= ${HOJE}), 0)::int AS un_h,
              COUNT(*) FILTER (WHERE o.date_created < ${HOJE} AND o.date_created < now() - interval '1 day')::int AS ped_o,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created < ${HOJE} AND o.date_created < now() - interval '1 day'), 0) AS fat_o,
              COALESCE(SUM(o.quantity) FILTER (WHERE o.date_created < ${HOJE} AND o.date_created < now() - interval '1 day'), 0)::int AS un_o
         FROM orders o WHERE o.date_created >= ${HOJE} - interval '1 day' AND o.status != 'cancelled' AND ${SEM_AMAZON}`),
    // Vendas por estado hoje (buyer_state_name — capturado do envio; pode faltar).
    pool.query(
      `SELECT COALESCE(NULLIF(o.buyer_state_name, ''), '') AS estado, COUNT(*)::int AS pedidos, COALESCE(SUM(o.total_amount), 0) AS fat
         FROM orders o WHERE o.date_created >= ${HOJE} AND o.status != 'cancelled' AND ${SEM_AMAZON}
        GROUP BY 1 ORDER BY pedidos DESC`),
    // Anúncios parados: vendiam bem (≥ 6 vendas entre 33 e 3 dias atrás) e 0 venda nos últimos 3 dias.
    pool.query(
      `SELECT i.ml_id, i.title AS titulo, i.available_quantity AS estoque, s.nickname AS loja,
              COUNT(*)::int AS vendas30, MAX(o.date_created) AS ultima
         FROM orders o JOIN items i ON i.ml_id = o.item_id LEFT JOIN stores s ON s.id = i.store_id
        WHERE o.status != 'cancelled' AND o.date_created >= now() - interval '33 days' AND i.status = 'active'
        GROUP BY i.ml_id, i.title, i.available_quantity, s.nickname
       HAVING MAX(o.date_created) < now() - interval '3 days' AND COUNT(*) >= 6
        ORDER BY vendas30 DESC LIMIT 6`),
    // Voltaram a vender: venderam hoje e a venda anterior foi há 7+ dias (primeiro os que ficaram
    // mais tempo parados); depois os de 1ª venda (sem venda anterior).
    pool.query(
      `SELECT * FROM (
         SELECT h.item_id, MAX(COALESCE(i.title, h.titulo)) AS titulo, MAX(s.nickname) AS loja, COUNT(*)::int AS hoje,
                (SELECT MAX(o2.date_created) FROM orders o2 WHERE o2.item_id = h.item_id AND o2.status != 'cancelled' AND o2.date_created < ${HOJE}) AS anterior
           FROM (SELECT o.item_id, o.title AS titulo, o.store_id FROM orders o
                  WHERE o.date_created >= ${HOJE} AND o.status != 'cancelled' AND ${SEM_AMAZON} AND o.item_id IS NOT NULL) h
           LEFT JOIN items i ON i.ml_id = h.item_id LEFT JOIN stores s ON s.id = h.store_id
          GROUP BY h.item_id) x
        WHERE x.anterior IS NULL OR x.anterior < now() - interval '7 days'
        ORDER BY (x.anterior IS NULL), x.anterior ASC LIMIT 6`),
    // Reputação: último snapshot de cada loja ML (sync-metricas 04:15).
    pool.query(
      `SELECT DISTINCT ON (m.store_id) s.nickname AS loja, m.level_id, m.power_seller_status, m.claims_pct, m.delayed_pct, m.cancellations_pct, m.collected_at
         FROM store_metrics m JOIN stores s ON s.id = m.store_id
        ORDER BY m.store_id, m.collected_at DESC`),
    // Clientes recorrentes hoje: comprador (buyer_nickname) que já tinha pedido antes de hoje (365 dias).
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE o.buyer_nickname IS NOT NULL AND EXISTS (
                SELECT 1 FROM orders a WHERE a.buyer_nickname = o.buyer_nickname AND a.status != 'cancelled'
                   AND a.date_created < ${HOJE} AND a.date_created >= now() - interval '365 days'))::int AS recorrentes,
              COUNT(*) FILTER (WHERE o.buyer_nickname IS NULL)::int AS sem_comprador
         FROM orders o WHERE o.date_created >= ${HOJE} AND o.status != 'cancelled' AND ${SEM_AMAZON}`),
  ]);
  const tk = ticket[0];
  // ── v134: melhor dia da semana e horário (últimos 30 dias fechados, fuso SP) ──
  const { rows: semHora } = await pool.query(
    `SELECT EXTRACT(ISODOW FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
            EXTRACT(HOUR FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS h,
            COUNT(*)::int AS pedidos, COALESCE(SUM(o.total_amount), 0) AS fat
       FROM orders o
      WHERE o.date_created >= ${HOJE} - interval '30 days' AND o.date_created < ${HOJE}
        AND o.status != 'cancelled' AND ${SEM_AMAZON}
      GROUP BY 1, 2`);
  // Média por dia da semana = total ÷ quantas vezes aquele dia aparece nos 30 dias.
  const ocorr = Array(8).fill(0);
  const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  for (let i = 1; i <= 30; i++) ocorr[DOW[new Date(Date.now() - i * 86400000).toLocaleDateString('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' })]]++;
  const porDia = [1, 2, 3, 4, 5, 6, 7].map(dw => { const xs = semHora.filter(r => r.dow === dw); const p = xs.reduce((a, r) => a + r.pedidos, 0), f = xs.reduce((a, r) => a + Number(r.fat), 0); return { dow: dw, pedidos_media: ocorr[dw] ? p / ocorr[dw] : 0, fat_media: ocorr[dw] ? f / ocorr[dw] : 0 }; });
  const porHora30 = Array.from({ length: 24 }, (_, h) => semHora.filter(r => r.h === h).reduce((a, r) => a + r.pedidos, 0));
  // ── v137: hoje × mesmo dia da semana passada, Shopee atenção, anúncios com nota baixa ──
  const [{ rows: semPassada }, { rows: chatShopee }, { rows: violShopee }, { rows: notaBaixa }, { rows: estadosMes }, { rows: vendasRitmo }, { rows: tiposEnvio }, { rows: sobeDesce }] = await Promise.all([
    // Hora a hora: hoje × o mesmo dia 7 dias atrás (dia inteiro; a tela compara até a mesma hora).
    pool.query(
      `SELECT EXTRACT(HOUR FROM o.date_created AT TIME ZONE 'America/Sao_Paulo')::int AS h,
              COUNT(*) FILTER (WHERE o.date_created >= ${HOJE})::int AS hoje,
              COUNT(*) FILTER (WHERE o.date_created < ${HOJE})::int AS sem,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created >= ${HOJE}), 0) AS fat_hoje,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.date_created < ${HOJE}), 0) AS fat_sem
         FROM orders o
        WHERE (o.date_created >= ${HOJE} OR (o.date_created >= ${HOJE} - interval '7 days' AND o.date_created < ${HOJE} - interval '6 days'))
          AND o.status != 'cancelled' AND ${SEM_AMAZON}
        GROUP BY 1`),
    // Chat Shopee não lido. O sync (marketplaceEventWorker, 10 min) só traz as NÃO lidas e não zera
    // as que foram lidas no app — então só conta as que o último sync confirmou (updated_at recente).
    pool.query(
      `SELECT c.buyer_name, c.unread_count, c.last_message, c.last_message_time, s.nickname AS loja
         FROM shopee_chat c LEFT JOIN stores s ON s.id = c.store_id
        WHERE c.unread_count > 0 AND c.updated_at > now() - interval '25 minutes'
        ORDER BY c.last_message_time ASC NULLS LAST`),
    // Anúncios Shopee banidos por violação (sync a cada 6h; quem foi reativado sai sozinho).
    pool.query(
      `SELECT v.title, s.nickname AS loja, v.updated_at FROM shopee_item_violations v LEFT JOIN stores s ON s.id = v.store_id
        ORDER BY v.updated_at DESC`),
    // Nota de qualidade (SEO Score, 04:30) — os piores entre os anúncios ML ativos que têm visita em 30 dias.
    pool.query(
      `SELECT q.item_id, i.title AS titulo, st.nickname AS loja, q.score, q.pictures_count, q.has_video, q.title_length,
              q.description_word_count, q.has_gtin, q.has_brand, q.has_model, q.required_attrs_missing, q.visits_30d, q.sales_30d,
              (SELECT ROUND(AVG(q2.score), 1) FROM item_seo_score q2 JOIN items i2 ON i2.ml_id = q2.item_id WHERE i2.status = 'active') AS media
         FROM item_seo_score q JOIN items i ON i.ml_id = q.item_id LEFT JOIN stores st ON st.id = q.store_id
        WHERE i.status = 'active' AND COALESCE(q.visits_30d, 0) > 0
        ORDER BY q.score ASC, q.visits_30d DESC LIMIT 4`),
    // v138 — Vendas por estado no mês (do dia 1 até agora, fuso SP), mesma regra do "hoje".
    pool.query(
      `SELECT COALESCE(NULLIF(o.buyer_state_name, ''), '') AS estado, COUNT(*)::int AS pedidos, COALESCE(SUM(o.total_amount), 0) AS fat
         FROM orders o
        WHERE o.date_created >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND o.status != 'cancelled' AND ${SEM_AMAZON}
        GROUP BY 1 ORDER BY pedidos DESC`),
    // v140 — Ritmo: horário de cada venda de ontem 00h até agora (mesma regra de pedidos).
    pool.query(
      `SELECT o.date_created AS em FROM orders o
        WHERE o.date_created >= ${HOJE} - interval '1 day' AND o.status != 'cancelled' AND ${SEM_AMAZON}
        ORDER BY o.date_created`),
    // v141 — Tipo de envio hoje (orders.shipping_type = logistic_type do ML; Shopee à parte).
    // Coleta = cross_docking (ML busca); Agência = xd_drop_off/drop_off/me1/me2 (levar no ponto).
    pool.query(
      `SELECT CASE
                WHEN m.code = 'SHOPEE' THEN 'shopee'
                WHEN o.shipping_type ILIKE '%fulfillment%' THEN 'full'
                WHEN o.shipping_type ILIKE '%self_service%' OR o.shipping_type ILIKE '%flex%' THEN 'flex'
                WHEN o.shipping_type ILIKE '%cross_docking%' THEN 'coleta'
                WHEN o.shipping_type ~* 'drop_off|me1|me2' THEN 'agencia'
                ELSE 'outros' END AS tipo,
              COUNT(*)::int AS pedidos
         FROM orders o LEFT JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.date_created >= ${HOJE} AND o.status != 'cancelled' AND ${SEM_AMAZON}
        GROUP BY 1 ORDER BY pedidos DESC`),
    // v141 — Sobe e desce: pedidos por anúncio nos últimos 7 dias × 7 anteriores (base mínima de 3).
    pool.query(
      `WITH v AS (
         SELECT o.item_id,
                COUNT(*) FILTER (WHERE o.date_created >= now() - interval '7 days')::int AS atual,
                COUNT(*) FILTER (WHERE o.date_created <  now() - interval '7 days')::int AS antes
           FROM orders o
          WHERE o.date_created >= now() - interval '14 days' AND o.status != 'cancelled' AND ${SEM_AMAZON} AND o.item_id IS NOT NULL
          GROUP BY o.item_id)
       SELECT v.item_id, v.atual, v.antes, i.title AS titulo, i.thumbnail AS thumb, s.nickname AS loja
         FROM v LEFT JOIN items i ON i.ml_id = v.item_id LEFT JOIN stores s ON s.id = i.store_id
        WHERE GREATEST(v.atual, v.antes) >= 3 AND v.atual <> v.antes`),
  ]);
  const ritmo = calcularRitmo(vendasRitmo.map(r => new Date(r.em).getTime()), Date.now());
  const diaSemPassada = new Date(Date.now() - 7 * 86400000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
  // O que falta em cada anúncio (só itens que dá pra corrigir no anúncio; limiares de seoScore.js).
  const faltasSeo = q => [
    q.pictures_count < 6 && `📷 ${q.pictures_count || 0} foto(s) (ideal 6+)`,
    q.required_attrs_missing > 0 && `📋 ${q.required_attrs_missing} atributo(s) obrigatório(s) faltando`,
    !q.has_video && '🎬 sem vídeo/clip',
    q.title_length < 45 && `✏️ título curto (${q.title_length || 0}/60)`,
    q.description_word_count < 100 && `📄 descrição curta (${q.description_word_count || 0} palavras)`,
    !q.has_gtin && '🔢 sem GTIN',
    !q.has_brand && '🏷️ sem marca',
  ].filter(Boolean);

  // ── v134: estado do servidor (mesmas métricas/limites da Saúde do Sistema, health.js) ──
  let servidor = null;
  try { const hl = require('../health'); const m = hl.serverMetrics(); servidor = { cpu: m.cpu.load_pct, cores: m.cpu.cores, mem: m.mem.used_pct, mem_total: m.mem.total, disco: m.disk ? m.disk.used_pct : null, disco_livre: m.disk ? m.disk.free : null, disco_total: m.disk ? m.disk.total : null, uptime_s: m.uptime_server_s, limite_disco: hl.DISK_MAX_PCT, limite_mem: hl.MEM_MAX_PCT }; }
  catch (e) { console.warn('[telegram-tela/painel] servidor:', e.message); }
  // Promoções vencendo hoje ou amanhã (fim do dia de amanhã, SP).
  const limiteAmanha = (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); d.setDate(d.getDate() + 1); d.setHours(23, 59, 59, 999); return Date.now() + (d - new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))); })();
  const vencendo = [
    ...promoMl.filter(p => p.fim && !isNaN(Date.parse(p.fim)) && Date.parse(p.fim) <= limiteAmanha).map(p => ({ origem: 'ML', titulo: p.titulo, loja: p.loja, fim: new Date(p.fim).toISOString() })),
    ...promoShopee.filter(p => p.end_time && Number(p.end_time) * 1000 <= limiteAmanha).map(p => ({ origem: 'Shopee', titulo: p.name, loja: p.loja, fim: new Date(Number(p.end_time) * 1000).toISOString(), desconto: p.desconto })),
  ].sort((a, b) => a.fim.localeCompare(b.fim)).slice(0, 6);
  let frase = null;
  try { frase = await require('../fraseDoDia').obterFraseDoDia(); } catch (e) { console.warn('[telegram-tela/painel] frase do dia:', e.message); }
  const placarBb = { ganhando: 0, compartilhando: 0, perdendo: 0 };
  const perdendoLista = [];
  bb.forEach(c => {
    const k = classificarBuybox({ calculado_em: c.calculated_at, winner_item_id: c.winner_item_id, item_id: c.item_id, status: c.status }).chave;
    if (k in placarBb) placarBb[k]++;
    if (k === 'perdendo' && c.current_price != null && c.winner_price != null) perdendoLista.push({ titulo: c.titulo, loja: c.loja, item_id: c.item_id, seu: Number(c.current_price), vencedor: Number(c.winner_price) });
  });
  // Mais perto de ganhar primeiro (menor diferença pro vencedor) — mesma ordem do relatório de Buy Box.
  perdendoLista.sort((a, b) => (a.seu - a.vencedor) - (b.seu - b.vencedor));
  // IA Estrategista: mesma carteira da tela (cache próprio de 10 min). Falha aqui não derruba o painel.
  let ia = [];
  try {
    const r = await require('../iaEstrategistaDados').carteira({ periodo: 14, storeId: '' });
    ia = r.anuncios.filter(x => x.prioridade.nota >= 20).slice(0, 4).map(x => ({
      nota: x.prioridade.nota, titulo: x.titulo, ico: x.analise.principal.ico,
      problema: x.analise.problemas[0]?.texto || x.analise.oportunidades[0]?.texto || x.analise.faltando[0] || x.analise.principal.nome,
      acao: x.analise.plano[0]?.acao || null,
    }));
  } catch (e) { console.warn('[telegram-tela/painel] IA Estrategista:', e.message); }
  const t = tot[0];
  const hbIdade = hbWorker ? Math.round((Date.now() - Number(hbWorker)) / 1000) : null;
  const vencidos = tokens.filter(k => !k.token_expires_at || new Date(k.token_expires_at).getTime() < Date.now() - 5 * 60000).map(k => k.nickname);
  return {
    servidor,
    saude: {
      worker: { ok: hbIdade != null && hbIdade < 120, idade_s: hbIdade }, // mesmo limite de health.js (HB_STALE_MS)
      tokens: { total: tokens.length, vencidos },
      ultima_venda: ult[0]?.ultima || null,
    },
    recorde: rec[0] ? { dia: rec[0].dia, fat: Number(rec[0].fat) } : null,
    ontem: { pedidos: t.pedidos_ontem_dia, fat: Number(t.fat_ontem_dia) },
    gerado_em: new Date().toISOString(),
    placar: { pedidos: t.pedidos_hoje, fat: Number(t.fat_hoje), pedidos_ontem: t.pedidos_ontem, fat_ontem: Number(t.fat_ontem),
      lojas: lojas.map(l => ({ loja: l.loja, mkt: l.mkt, pedidos: l.pedidos, fat: Number(l.fat) })) },
    estagios: Object.fromEntries(est.map(e => [e.fase, e.vendas])),
    buybox: placarBb,
    carrossel: {
      top_hoje: topHoje.map(t => ({ item_id: t.item_id, titulo: t.titulo, thumb: t.thumb, loja: t.loja, pedidos: t.pedidos, unidades: t.unidades, fat: Number(t.fat) })),
      por_hora: Array.from({ length: 24 }, (_, h) => { const x = porHora.find(r => r.h === h); return { h, hoje: x ? x.hoje : 0, ontem: x ? x.ontem : 0 }; }),
      estoque_risco: estoqueRisco,
      buybox_perdendo: perdendoLista.slice(0, 5),
      top_semana: topSemana.map(t => ({ item_id: t.item_id, titulo: t.titulo, thumb: t.thumb, loja: t.loja, pedidos: t.pedidos, fat: Number(t.fat), fat_ant: Number(t.fat_ant) })),
      promocoes: { ml_ativas: promoMl.length, shopee_ativas: promoShopee.length, vencendo,
        recentes: promoMl.slice().sort((a, b) => Number(b.discount_pct || 0) - Number(a.discount_pct || 0)).slice(0, 4).map(p => ({ titulo: p.titulo, loja: p.loja, preco: Number(p.promo_price) || null, desconto: Number(p.discount_pct) || null })) },
      perto_marco: pertoMarco.map(r => ({ titulo: r.titulo, fase: r.fase, vendas: r.sales_count, every: r.every, faltam: Number(r.faltam), marco: r.sales_count + Number(r.faltam) })),
      frase,
      bipados: { total_envios: bipHoje.reduce((a, b) => a + b.envios, 0), total_pedidos: bipHoje.reduce((a, b) => a + b.pedidos, 0), equipe: bipHoje.slice(0, 6) },
      ticket: { hoje: { pedidos: tk.ped_h, ticket: tk.ped_h ? Number(tk.fat_h) / tk.ped_h : 0, unidades: tk.ped_h ? tk.un_h / tk.ped_h : 0 },
                ontem: { pedidos: tk.ped_o, ticket: tk.ped_o ? Number(tk.fat_o) / tk.ped_o : 0, unidades: tk.ped_o ? tk.un_o / tk.ped_o : 0 } },
      estados: estados.map(e => ({ estado: e.estado || null, pedidos: e.pedidos, fat: Number(e.fat) })),
      parados: parados.map(p => ({ titulo: p.titulo, loja: p.loja, estoque: p.estoque, vendas30: p.vendas30, dias: Math.floor((Date.now() - new Date(p.ultima).getTime()) / 86400000) })),
      voltaram: voltaram.map(v => ({ titulo: v.titulo, loja: v.loja, hoje: v.hoje, dias_parado: v.anterior ? Math.floor((Date.now() - new Date(v.anterior).getTime()) / 86400000) : null })),
      reputacao: reput.map(r => ({ loja: r.loja, level_id: r.level_id, power: r.power_seller_status, reclamacoes: r.claims_pct != null ? Number(r.claims_pct) : null, atrasos: r.delayed_pct != null ? Number(r.delayed_pct) : null, cancelamentos: r.cancellations_pct != null ? Number(r.cancellations_pct) : null, em: r.collected_at })),
      recorrentes: recorr[0],
      melhor: { por_dia: porDia, por_hora: porHora30 },
      ritmo,
      tipos_envio: tiposEnvio,
      sobe: sobeDesce.filter(x => x.atual > x.antes).sort((a, b) => (b.atual - b.antes) - (a.atual - a.antes) || b.atual - a.atual).slice(0, 3),
      desce: sobeDesce.filter(x => x.atual < x.antes).sort((a, b) => (b.antes - b.atual) - (a.antes - a.atual) || b.antes - a.antes).slice(0, 3),
      estados_mes: estadosMes.map(e => ({ estado: e.estado || null, pedidos: e.pedidos, fat: Number(e.fat) })),
      semana_passada: { dia: diaSemPassada,
        por_hora: Array.from({ length: 24 }, (_, h) => { const x = semPassada.find(r => r.h === h); return { h, hoje: x ? x.hoje : 0, sem: x ? x.sem : 0, fat_hoje: x ? Number(x.fat_hoje) : 0, fat_sem: x ? Number(x.fat_sem) : 0 }; }) },
      shopee: { chats: chatShopee.length, mensagens: chatShopee.reduce((a, c) => a + Number(c.unread_count || 0), 0),
        chats_lista: chatShopee.slice(0, 4).map(c => ({ comprador: c.buyer_name, loja: c.loja, nao_lidas: Number(c.unread_count || 0), texto: c.last_message, em: c.last_message_time ? new Date(Number(c.last_message_time) / 1e6).toISOString() : null })),
        violacoes: violShopee.length, violacoes_lista: violShopee.slice(0, 3).map(v => ({ titulo: v.title, loja: v.loja })) },
      nota_baixa: { media: notaBaixa[0] ? Number(notaBaixa[0].media) : null,
        itens: notaBaixa.map(q => ({ item_id: q.item_id, titulo: q.titulo, loja: q.loja, nota: Number(q.score), visitas30: q.visits_30d, vendas30: q.sales_30d, faltas: faltasSeo(q).slice(0, 2) })) },
    },
    ia,
  };
}
async function painel(req, res) {
  try { res.json(await cached('telegram-tela:painel', 20, montarPainel)); }
  catch (e) { console.error('[api/telegram-tela/painel]', e.message); res.status(500).json({ error: e.message }); }
}

router.get('/', listar);
router.get('/painel', painel);
// Link da TV (cria o token na 1ª vez) / gerar um novo (revoga o anterior).
router.get('/link-tv', async (req, res) => {
  try { res.json({ token: await tokenTv(false) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/link-tv/novo', async (req, res) => {
  try { res.json({ token: await tokenTv(true) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

async function exigirToken(req, res, next) {
  try {
    const t = String(req.query.token || '');
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key = 'telegram_tela_token'`);
    const certo = rows[0] && rows[0].value;
    if (!/^[0-9a-f]{32}$/.test(t) || !certo || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(certo))) {
      return res.status(403).json({ error: 'link da TV inválido — gere um novo na Tela Telegram' });
    }
    return next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
publicRouter.get('/', exigirToken, listar);
publicRouter.get('/painel', exigirToken, painel);

module.exports = { calcularRitmo, router, publicRouter };
