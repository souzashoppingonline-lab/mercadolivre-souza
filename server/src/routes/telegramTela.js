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

async function listar(req, res) {
  try {
    const depois = Number(req.query.depois_id) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
    const { rows } = depois
      ? await pool.query(`SELECT id, topico, texto, html, direcao, autor, criado_em FROM telegram_mensagens WHERE id > $1 ORDER BY id ASC LIMIT $2`, [depois, limit])
      : await pool.query(`SELECT * FROM (SELECT id, topico, texto, html, direcao, autor, criado_em FROM telegram_mensagens ORDER BY id DESC LIMIT $1) x ORDER BY id ASC`, [limit]);
    const { rows: h } = await pool.query(`SELECT COUNT(*)::int AS n FROM telegram_mensagens WHERE criado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`);
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
      `SELECT cc.item_id, cc.status, cc.winner_item_id, cc.calculated_at
         FROM catalog_competition cc LEFT JOIN items i ON i.ml_id = cc.item_id
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
  const placarBb = { ganhando: 0, compartilhando: 0, perdendo: 0 };
  bb.forEach(c => { const k = classificarBuybox({ calculado_em: c.calculated_at, winner_item_id: c.winner_item_id, item_id: c.item_id, status: c.status }).chave; if (k in placarBb) placarBb[k]++; });
  // IA Estrategista: mesma carteira da tela (cache próprio de 10 min). Falha aqui não derruba o painel.
  let ia = [];
  try {
    const r = await require('../iaEstrategistaDados').carteira({ periodo: 14, storeId: '' });
    ia = r.anuncios.filter(x => x.prioridade.nota >= 20).slice(0, 3).map(x => ({
      nota: x.prioridade.nota, titulo: x.titulo, ico: x.analise.principal.ico,
      problema: x.analise.problemas[0]?.texto || x.analise.oportunidades[0]?.texto || x.analise.faltando[0] || x.analise.principal.nome,
      acao: x.analise.plano[0]?.acao || null,
    }));
  } catch (e) { console.warn('[telegram-tela/painel] IA Estrategista:', e.message); }
  const t = tot[0];
  const hbIdade = hbWorker ? Math.round((Date.now() - Number(hbWorker)) / 1000) : null;
  const vencidos = tokens.filter(k => !k.token_expires_at || new Date(k.token_expires_at).getTime() < Date.now() - 5 * 60000).map(k => k.nickname);
  return {
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

module.exports = { router, publicRouter };
