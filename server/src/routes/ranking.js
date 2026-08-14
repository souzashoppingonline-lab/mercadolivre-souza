// Rankeamento de anúncios — API de leitura/gestão da página pages/rankeamento.html.
// A lógica de notificação (venda/alteração/marco) vive em ../ranking.js e é
// disparada pelo worker; aqui só CRUD dos anúncios monitorados + timeline.
// Ver .claude/rankeamento.md.
const express = require('express');
const pool = require('../db/pool');
const ranking = require('../ranking');

const router = express.Router();
const MAX_ADS = 30; // trava de segurança: snapshot roda por anúncio ativo

// Lista os anúncios em rankeamento com estatísticas derivadas (ritmo, dias).
router.get('/ads', async (req, res) => {
  try {
    const mkt = String(req.query.marketplace || '').trim().toUpperCase(); // '', 'ML' ou 'SHOPEE'
    const fase = String(req.query.fase || '').trim().toLowerCase();       // '', 'rankeando', 'ranqueado' ou 'monitoramento'
    const storeId = String(req.query.store_id || '').trim();              // '' ou id da loja
    const ciclo = String(req.query.ciclo || '').trim();                  // '' ou número do ciclo
    const params = [];
    const conds = [];
    if (mkt === 'ML' || mkt === 'SHOPEE') { params.push(mkt); conds.push(`COALESCE(m.code, 'ML') = $${params.length}`); }
    if (['rankeando', 'ranqueado', 'monitoramento'].includes(fase)) { params.push(fase); conds.push(`r.fase = $${params.length}`); }
    if (storeId) { params.push(storeId); conds.push(`r.store_id = $${params.length}`); }
    if (ciclo && /^\d+$/.test(ciclo)) { params.push(ciclo); conds.push(`r.ciclo = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT r.*, i.thumbnail, i.permalink, i.available_quantity AS estoque_atual,
              i.price AS preco_atual, i.status AS status_atual, s.nickname AS store_nickname,
              COALESCE(m.code, 'ML') AS marketplace,
              -- Faturamento acumulado (as vendas contam através dos ciclos).
              (SELECT COALESCE(SUM((e.detail->>'valor')::numeric), 0) FROM ranking_events e
                 WHERE e.ranking_ad_id = r.id AND e.event_type = 'venda') AS faturamento,
              (SELECT COUNT(*)::int FROM ranking_ciclos c WHERE c.ranking_ad_id = r.id) AS ciclos_anteriores,
              (SELECT COALESCE(json_agg(json_build_object('id', l.id, 'ml_id', l.ml_id, 'tipo', l.tipo, 'title', li.title) ORDER BY l.id), '[]'::json)
                 FROM ranking_ad_links l LEFT JOIN items li ON li.ml_id = l.ml_id
                WHERE l.ranking_ad_id = r.id) AS links,
              (SELECT COUNT(*)::int FROM ranking_notes nt WHERE nt.ranking_ad_id = r.id) AS notas_count
         FROM ranking_ads r
         LEFT JOIN items i ON i.ml_id = r.ml_id
         LEFT JOIN marketplaces m ON m.id = i.marketplace_id
         LEFT JOIN stores s ON s.id = r.store_id
        ${where}
        ORDER BY r.active DESC, r.last_sale_at DESC NULLS LAST, r.created_at DESC`,
      params
    );
    const now = Date.now();
    const ads = rows.map((r) => {
      const dias = r.first_sale_at ? Math.max(1, (now - new Date(r.first_sale_at).getTime()) / 86400000) : null;
      const diasRank = r.started_at ? (now - new Date(r.started_at).getTime()) / 86400000 : 0;
      // Sugestão de "pronto pra ranqueado" (só fase 1): bateu qualquer critério
      // objetivo que já capturamos. Quem confirma é o usuário (transição manual).
      const sugerir = r.fase === 'rankeando' && (
        r.last_highlight_pos != null || r.last_buybox === true ||
        r.sales_count >= 10 || diasRank >= 15
      );
      return { ...r, ritmo_dia: dias ? Number((r.sales_count / dias).toFixed(1)) : null, dias: dias ? Number(dias.toFixed(1)) : null, sugerir_ranqueado: sugerir };
    });
    res.json({ ads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Busca anúncios (items) para adicionar ao rankeamento — por ml_id ou título.
router.get('/buscar', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const mkt = String(req.query.marketplace || '').trim().toUpperCase(); // '', 'ML' ou 'SHOPEE'
    const storeId = String(req.query.store_id || '').trim();              // '' ou id da loja
    // q vazio → lista os anúncios mais recentes (a "tabela com todos os anúncios").
    // Com q → filtra por ml_id/título. Marca quais já estão em rankeamento.
    const params = [];
    let where = `i.status <> 'closed'`;
    if (q.length >= 2) { params.push(`%${q}%`); where += ` AND (i.ml_id ILIKE $${params.length} OR i.title ILIKE $${params.length})`; }
    if (mkt === 'ML' || mkt === 'SHOPEE') { params.push(mkt); where += ` AND COALESCE(m.code, 'ML') = $${params.length}`; }
    if (storeId) { params.push(storeId); where += ` AND i.store_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT i.ml_id, i.title, i.price, i.available_quantity, i.status, i.thumbnail, i.sold_quantity,
              s.nickname AS store_nickname, COALESCE(m.code, 'ML') AS marketplace,
              (r.id IS NOT NULL AND r.active) AS em_rankeamento
         FROM items i
         LEFT JOIN stores s ON s.id = i.store_id
         LEFT JOIN marketplaces m ON m.id = i.marketplace_id
         LEFT JOIN ranking_ads r ON r.ml_id = i.ml_id
        WHERE ${where}
        ORDER BY i.updated_at DESC LIMIT ${q.length >= 2 ? 30 : 100}`,
      params
    );
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marca um anúncio como "em rankeamento". Semeia os últimos valores conhecidos
// (preço/estoque/status) a partir de items, pra a 1ª alteração real não gerar
// alerta falso.
router.post('/ads', async (req, res) => {
  try {
    const mlId = String(req.body.ml_id || '').trim();
    if (!mlId) return res.status(400).json({ error: 'ml_id obrigatório' });
    const every = Number(req.body.milestone_every) > 0 ? Number(req.body.milestone_every) : 5;

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM ranking_ads WHERE active = true`);
    if (cnt.rows[0].n >= MAX_ADS) {
      return res.status(400).json({ error: `Limite de ${MAX_ADS} anúncios em rankeamento atingido. Desative algum antes de adicionar outro.` });
    }
    const { rows: it } = await pool.query(
      `SELECT ml_id, store_id, title, price, available_quantity, status FROM items WHERE ml_id = $1`, [mlId]
    );
    if (!it.length) return res.status(404).json({ error: 'Anúncio não encontrado no banco (ainda não sincronizado).' });
    const i = it[0];
    const { rows } = await pool.query(
      `INSERT INTO ranking_ads (ml_id, store_id, title, base_price, last_price, last_available_quantity, last_status, milestone_every, active, started_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,true, now())
       ON CONFLICT (ml_id) DO UPDATE SET active = true, milestone_every = EXCLUDED.milestone_every, updated_at = now()
       RETURNING *`,
      [i.ml_id, i.store_id, i.title, i.price, i.available_quantity, i.status, every]
    );
    res.json({ ad: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pausar/retomar ou mudar o intervalo do marco.
router.patch('/ads/:id', async (req, res) => {
  try {
    const sets = [], vals = [req.params.id]; let n = 1;
    if (req.body.active != null)          { sets.push(`active = $${++n}`); vals.push(!!req.body.active); }
    if (Number(req.body.milestone_every) > 0) { sets.push(`milestone_every = $${++n}`); vals.push(Number(req.body.milestone_every)); }
    // Nome da campanha de ADS (texto, ''/null → zera).
    if (Object.prototype.hasOwnProperty.call(req.body, 'campanha_nome')) {
      const v = req.body.campanha_nome;
      sets.push(`campanha_nome = $${++n}`); vals.push((v == null || v === '') ? null : String(v).slice(0, 200));
    }
    // Métricas de ADS informadas manualmente no card ('' ou null → zera a coluna).
    for (const campo of ['ads_investido', 'roas', 'orcamento_diario', 'preco_anterior', 'preco_atual']) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
        const v = req.body[campo];
        const num = (v === '' || v == null) ? null : Number(v);
        if (num != null && (!isFinite(num) || num < 0)) return res.status(400).json({ error: `${campo} inválido` });
        sets.push(`${campo} = $${++n}`); vals.push(num);
      }
    }
    // Mudança de fase (transição manual): 'ranqueado' carimba ranqueado_em;
    // voltar pra 'rankeando' limpa o carimbo (reempurrar); 'monitoramento' carimba
    // monitoramento_started_at (rastreia quando entrou em monitoramento para contar
    // dias corretamente no card).
    const fase = String(req.body.fase || '').trim().toLowerCase();
    if (['rankeando', 'ranqueado', 'monitoramento'].includes(fase)) {
      sets.push(`fase = $${++n}`); vals.push(fase);
      if (fase === 'ranqueado') sets.push(`ranqueado_em = now()`);
      else if (fase === 'rankeando') sets.push(`ranqueado_em = NULL`);
      else if (fase === 'monitoramento') sets.push(`monitoramento_started_at = now()`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    sets.push('updated_at = now()');
    const { rows } = await pool.query(`UPDATE ranking_ads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    res.json({ ad: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove do rankeamento (apaga histórico de eventos via CASCADE).
router.delete('/ads/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ranking_ads WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Timeline de eventos de um anúncio (vendas + alterações + marcos), mais recentes primeiro.
router.get('/ads/:id/eventos', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const { rows } = await pool.query(
      `SELECT id, event_type, message, detail, created_at
         FROM ranking_events WHERE ranking_ad_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ eventos: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Encerra o ciclo atual e começa o próximo. Arquiva um snapshot do ciclo
// (ADS/ROAS/orçamento/preços manuais + vendas e faturamento ACUMULADOS) em
// ranking_ciclos, incrementa `ciclo` e desloca o preço (o preço atual do ciclo
// vira o "preço anterior" do próximo). NÃO zera o contador de vendas — as
// vendas seguem cumulativas através dos ciclos.
router.post('/ads/:id/ciclo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ad } = await client.query(`SELECT * FROM ranking_ads WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!ad.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'anúncio não encontrado' }); }
    const r = ad[0];
    // Faturamento acumulado (snapshot no momento da troca de ciclo).
    const { rows: fat } = await client.query(
      `SELECT COALESCE(SUM((detail->>'valor')::numeric), 0) AS f FROM ranking_events
        WHERE ranking_ad_id = $1 AND event_type = 'venda'`,
      [r.id]
    );
    await client.query(
      `INSERT INTO ranking_ciclos (ranking_ad_id, ciclo, campanha_nome, ads_investido, roas, orcamento_diario, preco_anterior, preco_atual, sales_count, faturamento, iniciado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, r.ciclo || 1, r.campanha_nome, r.ads_investido, r.roas, r.orcamento_diario, r.preco_anterior, r.preco_atual, r.sales_count, fat[0].f, r.ciclo_iniciado_em]
    );
    const { rows } = await client.query(
      `UPDATE ranking_ads
          SET ciclo = COALESCE(ciclo,1) + 1,
              preco_anterior = preco_atual,   -- o preço do ciclo que fecha vira o "anterior"
              ciclo_iniciado_em = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [r.id]
    );
    await client.query('COMMIT');
    res.json({ ad: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ranking] POST /ads/:id/ciclo falhou:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Log de alterações / anotações do card (usado no estágio Monitoramento, mas
// disponível em qualquer fase). Mais recentes primeiro.
router.get('/ads/:id/notas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, texto, created_at FROM ranking_notes WHERE ranking_ad_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ notas: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/ads/:id/notas', async (req, res) => {
  try {
    const texto = String(req.body.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'texto obrigatório' });
    const { rows } = await pool.query(
      `INSERT INTO ranking_notes (ranking_ad_id, texto) VALUES ($1, $2) RETURNING id, texto, created_at`,
      [req.params.id, texto.slice(0, 4000)]
    );
    res.json({ nota: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/ads/:id/notas/:notaId', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ranking_notes WHERE id = $1 AND ranking_ad_id = $2`, [req.params.notaId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vincula um ml_id (ex.: anúncio de catálogo) ao card — a venda desse ml_id
// passa a contar no mesmo card. Valida: o item existe, não é card principal de
// outro rankeamento, e ainda não está vinculado.
router.post('/ads/:id/links', async (req, res) => {
  try {
    const mlId = String(req.body.ml_id || '').trim();
    if (!mlId) return res.status(400).json({ error: 'ml_id obrigatório' });
    const tipo = ['catalogo', 'tradicional', 'outro'].includes(String(req.body.tipo || '').trim()) ? req.body.tipo.trim() : 'catalogo';

    const it = await pool.query(`SELECT ml_id FROM items WHERE ml_id = $1`, [mlId]);
    if (!it.rows.length) return res.status(404).json({ error: 'Anúncio não encontrado no banco (ainda não sincronizado).' });

    const prim = await pool.query(`SELECT id FROM ranking_ads WHERE ml_id = $1`, [mlId]);
    if (prim.rows.length) return res.status(400).json({ error: 'Esse anúncio já é um card de rankeamento próprio — remova o card dele antes de vincular.' });

    const ja = await pool.query(`SELECT ranking_ad_id FROM ranking_ad_links WHERE ml_id = $1`, [mlId]);
    if (ja.rows.length) return res.status(400).json({ error: 'Esse anúncio já está vinculado a um card.' });

    const { rows } = await pool.query(
      `INSERT INTO ranking_ad_links (ranking_ad_id, ml_id, tipo) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, mlId, tipo]
    );
    res.json({ link: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Desvincula um ml_id do card.
router.delete('/ads/:id/links/:linkId', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ranking_ad_links WHERE id = $1 AND ranking_ad_id = $2`, [req.params.linkId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Histórico de mudanças de PREÇO do anúncio (eventos 'preco' com de→para e data),
// mais recente primeiro. Alimenta o modal de histórico de preço no card.
router.get('/ads/:id/precos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT created_at, detail FROM ranking_events
        WHERE ranking_ad_id = $1 AND event_type = 'preco'
        ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ precos: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Histórico de ciclos encerrados de um anúncio (mais recente primeiro).
router.get('/ads/:id/ciclos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ciclo, campanha_nome, ads_investido, roas, orcamento_diario, preco_anterior, preco_atual, sales_count, faturamento, iniciado_em, encerrado_em
         FROM ranking_ciclos WHERE ranking_ad_id = $1 ORDER BY ciclo DESC`,
      [req.params.id]
    );
    res.json({ ciclos: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
