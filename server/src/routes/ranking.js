// Rankeamento de anúncios — API de leitura/gestão da página pages/rankeamento.html.
// A lógica de notificação (venda/alteração/marco) vive em ../ranking.js e é
// disparada pelo worker; aqui só CRUD dos anúncios monitorados + timeline.
// Ver .claude/rankeamento.md.
const express = require('express');
const pool = require('../db/pool');
const ranking = require('../ranking');
const redis = require('../db/redis');

const router = express.Router();
const MAX_ADS = 30; // trava de segurança: snapshot roda por anúncio ativo
// Estágios válidos (v80 acrescentou 'recuperacao'). Ver .claude/rankeamento.md.
const FASES = ['rankeando', 'ranqueado', 'monitoramento', 'recuperacao'];

// Diagnóstico da fase RECUPERAÇÃO: cruza tráfego × conversão pra dizer O QUE
// mexer, em vez de deixar o usuário adivinhar. Thresholds em .claude/business-rules.md.
const VISITAS_BAIXAS = 10;   // visitas/dia abaixo disso = problema de exposição
const CONV_BAIXA = 0.01;     // conversão (0..1) abaixo disso = problema de oferta
function diagnosticar({ visitasDia, conversao }) {
  if (visitasDia == null) return { tipo: 'SEM_DADOS', titulo: 'Sem dados ainda', texto: 'Aguardando o primeiro snapshot de visitas (roda a cada 6h).', acao: '' };
  if (visitasDia === 0) return { tipo: 'INVISIVEL', titulo: 'Invisível', texto: 'Nenhuma visita — o anúncio não está sendo exibido.', acao: 'Confira status, estoque e se a categoria está correta.' };
  if (visitasDia < VISITAS_BAIXAS) return { tipo: 'EXPOSICAO', titulo: 'Exposição', texto: `${visitasDia} visita(s)/dia — quase ninguém está vendo o anúncio.`, acao: 'Mexa em ADS, título/palavras-chave, categoria e preço de entrada.' };
  if (conversao == null || conversao < CONV_BAIXA) return { tipo: 'OFERTA', titulo: 'Oferta', texto: `${visitasDia} visitas/dia e conversão ${conversao == null ? 'sem histórico' : (conversao * 100).toFixed(1) + '%'} — está sendo visto e não converte.`, acao: 'Mexa em preço, fotos, descrição, frete e atributos.' };
  return { tipo: 'VOLUME', titulo: 'Volume', texto: `Converte (${(conversao * 100).toFixed(1)}%) mas o tráfego não sustenta vendas.`, acao: 'Aumente o tráfego: ADS e posicionamento.' };
}

// Veredito de uma intervenção: compara o baseline carimbado no registro com os
// números de agora. Só conclui depois da janela de N dias (antes disso, "medindo").
const JANELA_EFEITO_DIAS = 7;
function medirEfeito(baseline, atual, createdAt) {
  if (!baseline) return null;
  const dias = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  const vendas = (atual.vendas != null && baseline.vendas != null) ? Number(atual.vendas) - Number(baseline.vendas) : null;
  const visitasDe = baseline.visitas != null ? Number(baseline.visitas) : null;
  const visitasPara = atual.visitas != null ? Number(atual.visitas) : null;
  const pct = (visitasDe && visitasPara != null) ? ((visitasPara - visitasDe) / visitasDe) * 100 : null;
  const base = { dias: Number(dias.toFixed(1)), vendas, visitas_de: visitasDe, visitas_para: visitasPara, visitas_pct: pct != null ? Number(pct.toFixed(0)) : null };
  if (dias < JANELA_EFEITO_DIAS) return { ...base, veredito: 'medindo', faltam: Math.ceil(JANELA_EFEITO_DIAS - dias) };
  if (vendas > 0) return { ...base, veredito: 'funcionou' };
  if (pct != null && pct >= 20) return { ...base, veredito: 'parcial' };   // mais tráfego, ainda sem venda
  if (pct != null && pct <= -20) return { ...base, veredito: 'piorou' };
  return { ...base, veredito: 'sem_efeito' };
}

// Métricas atuais de um card — usadas pra carimbar o baseline da intervenção e
// pra medir o efeito depois. Uma query só, reaproveitada nas duas pontas.
async function metricasAtuais(adId) {
  const { rows } = await pool.query(
    `SELECT r.last_visits AS visitas, r.sales_count AS vendas, r.last_seo_score AS score,
            sq.conversion_rate AS conversao, i.price AS preco
       FROM ranking_ads r
       LEFT JOIN item_seo_score sq ON sq.item_id = r.ml_id
       LEFT JOIN items i ON i.ml_id = r.ml_id
      WHERE r.id = $1`, [adId]
  );
  return rows[0] || {};
}

// Lista os anúncios em rankeamento com estatísticas derivadas (ritmo, dias).
router.get('/ads', async (req, res) => {
  try {
    const mkt = String(req.query.marketplace || '').trim().toUpperCase(); // '', 'ML' ou 'SHOPEE'
    const fase = String(req.query.fase || '').trim().toLowerCase();       // '' ou um de FASES
    const storeId = String(req.query.store_id || '').trim();              // '' ou id da loja
    const ciclo = String(req.query.ciclo || '').trim();                  // '' ou número do ciclo
    const params = [];
    const conds = [];
    if (mkt === 'ML' || mkt === 'SHOPEE') { params.push(mkt); conds.push(`COALESCE(m.code, 'ML') = $${params.length}`); }
    if (FASES.includes(fase)) { params.push(fase); conds.push(`r.fase = $${params.length}`); }
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
              (SELECT COUNT(*)::int FROM ranking_notes nt WHERE nt.ranking_ad_id = r.id) AS notas_count,
              0 AS devolucoes_count,
              -- v80 (fase recuperação): tudo que o ML já nos deu e que diz O QUE mexer.
              sq.conversion_rate, sq.score AS seo_score, sq.visits_30d, sq.sales_30d,
              sq.pictures_count, sq.has_video, sq.title_length, sq.description_word_count,
              sq.required_attrs_missing, sq.missing_required_attrs, sq.is_full,
              cc.price_to_win, cc.status AS buybox_status, cc.winner_item_id,
              (SELECT ROUND(AVG(v.visits)) FROM item_visits v
                 WHERE v.item_id = r.ml_id AND v.date >= CURRENT_DATE - 7) AS visitas_media_7d,
              -- vendas DESDE que entrou em recuperação (≠ sales_count cumulativo)
              (SELECT COUNT(*)::int FROM ranking_events ev
                 WHERE ev.ranking_ad_id = r.id AND ev.event_type = 'venda'
                   AND ev.created_at >= r.recuperacao_started_at) AS vendas_na_fase,
              -- Intervenções (notas tipadas) já no payload do card — evita 1 request
              -- por card. Mesmo padrão do agregado de links acima; o card usa as 3
              -- últimas (corte no JS, pra não aninhar subquery correlacionada).
              (SELECT COALESCE(json_agg(json_build_object(
                        'id', nt2.id, 'texto', nt2.texto, 'tipo', nt2.tipo,
                        'baseline', nt2.baseline, 'created_at', nt2.created_at)
                      ORDER BY nt2.created_at DESC), '[]'::json)
                 FROM ranking_notes nt2
                WHERE nt2.ranking_ad_id = r.id AND nt2.tipo IS NOT NULL) AS intervencoes
         FROM ranking_ads r
         LEFT JOIN items i ON i.ml_id = r.ml_id
         LEFT JOIN marketplaces m ON m.id = i.marketplace_id
         LEFT JOIN stores s ON s.id = r.store_id
         LEFT JOIN item_seo_score sq ON sq.item_id = r.ml_id
         LEFT JOIN catalog_competition cc ON cc.item_id = r.ml_id
        ${where}
        ORDER BY r.active DESC, r.last_sale_at DESC NULLS LAST, r.created_at DESC`,
      params
    );
    const now = Date.now();
    const ads = rows.map((r) => {
      const dias = r.first_sale_at ? Math.max(1, (now - new Date(r.first_sale_at).getTime()) / 86400000) : null;
      const diasRank = r.started_at ? (now - new Date(r.started_at).getTime()) / 86400000 : 0;
      // Nível: 1 + (sales_count / 10), mostrado em RANQUEADO
      const nivel = 1 + Math.floor((r.sales_count || 0) / 10);
      // Sugestão de "pronto pra ranqueado" (só fase 1): bateu qualquer critério
      // objetivo que já capturamos. Quem confirma é o usuário (transição manual).
      const sugerir = r.fase === 'rankeando' && (
        r.last_highlight_pos != null || r.last_buybox === true ||
        r.sales_count >= 10 || diasRank >= 15
      );
      // ── Fase recuperação (v80) ──────────────────────────────────────────
      // Dias sem vender: desde a última venda; se NUNCA vendeu, desde que entrou
      // em rankeamento (é exatamente o caso que motiva a fase).
      const refSemVenda = r.last_sale_at || r.started_at;
      const diasSemVenda = refSemVenda ? Math.floor((now - new Date(refSemVenda).getTime()) / 86400000) : null;
      // Semáforo por tempo parado — só marca, nunca age sozinho (a exclusão é manual).
      const semaforo = diasSemVenda == null ? null : (diasSemVenda >= 15 ? 'decisao' : (diasSemVenda >= 8 ? 'atencao' : 'observando'));
      // Visitas/qualidade/buy-box com FALLBACK: os campos `last_*` só existem
      // depois que o snapshot roda naquela fase, então um card recém-movido (ou
      // de fase que não era varrida) mostrava "—". Aqui caímos para o que já
      // temos no banco: média de visitas de 7 dias (item_visits, populado pelo
      // sync geral), score de item_seo_score e o vencedor do buy-box de
      // catalog_competition. O snapshot continua sendo a fonte mais fresca.
      const visitasDia = r.last_visits != null ? Number(r.last_visits) : (r.visitas_media_7d != null ? Number(r.visitas_media_7d) : null);
      const qualidade = r.last_seo_score != null ? Number(r.last_seo_score) : (r.seo_score != null ? Number(r.seo_score) : null);
      const buybox = r.last_buybox != null ? r.last_buybox : (r.winner_item_id ? String(r.winner_item_id) === String(r.ml_id) : null);
      const conversao = r.conversion_rate != null ? Number(r.conversion_rate) : null;
      const diagnostico = r.fase === 'recuperacao' ? diagnosticar({ visitasDia, conversao }) : null;
      // Efeito de cada intervenção medido contra os números de agora deste card.
      const atual = { visitas: r.last_visits, vendas: r.sales_count };
      const intervencoes = (r.intervencoes || []).slice(0, 3)
        .map(n => ({ ...n, efeito: medirEfeito(n.baseline, atual, n.created_at) }));
      return {
        ...r, nivel,
        ritmo_dia: dias ? Number((r.sales_count / dias).toFixed(1)) : null,
        dias: dias ? Number(dias.toFixed(1)) : null,
        sugerir_ranqueado: sugerir,
        dias_sem_venda: diasSemVenda, semaforo, visitas_dia: visitasDia, diagnostico, intervencoes,
        qualidade, buybox, nunca_vendeu: !r.last_sale_at,
      };
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
    if (FASES.includes(fase)) {
      sets.push(`fase = $${++n}`); vals.push(fase);
      if (fase === 'ranqueado') sets.push(`ranqueado_em = now()`);
      else if (fase === 'rankeando') sets.push(`ranqueado_em = NULL`);
      else if (fase === 'monitoramento') sets.push(`monitoramento_started_at = now()`);
      else if (fase === 'recuperacao') sets.push(`recuperacao_started_at = now()`); // v80
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
  try {
    // Mesma transação usada pela troca AUTOMÁTICA no marco de N vendas
    // (server/src/ranking.js). Aqui é o botão do card, pra forçar a virada
    // antes do marco.
    const ad = await ranking.avancarCiclo(req.params.id);
    if (!ad) return res.status(404).json({ error: 'anúncio não encontrado' });
    res.json({ ad });
  } catch (e) {
    console.error('[ranking] POST /ads/:id/ciclo falhou:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Log de alterações / anotações do card (usado no estágio Monitoramento, mas
// disponível em qualquer fase). Mais recentes primeiro.
// v80: cada nota pode ser uma INTERVENÇÃO tipada; o efeito é medido na leitura
// comparando o baseline carimbado no registro com os números de agora.
router.get('/ads/:id/notas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, texto, tipo, baseline, created_at FROM ranking_notes
        WHERE ranking_ad_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    const atual = await metricasAtuais(req.params.id);
    const notas = rows.map(n => ({ ...n, efeito: medirEfeito(n.baseline, atual, n.created_at) }));
    res.json({ notas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/ads/:id/notas', async (req, res) => {
  try {
    const texto = String(req.body.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'texto obrigatório' });
    const TIPOS = ['titulo', 'keywords', 'fotos', 'descricao', 'preco', 'ads', 'atributos', 'frete', 'outro'];
    const tipo = TIPOS.includes(String(req.body.tipo || '').trim()) ? req.body.tipo.trim() : null;
    // Baseline: só faz sentido quando a nota é uma intervenção tipada (é ela que
    // vira "antes" da medição). Nota livre continua sendo só texto, como antes.
    const m = tipo ? await metricasAtuais(req.params.id) : null;
    const baseline = m ? JSON.stringify({
      visitas: m.visitas != null ? Number(m.visitas) : null,
      conversao: m.conversao != null ? Number(m.conversao) : null,
      score: m.score != null ? Number(m.score) : null,
      vendas: m.vendas != null ? Number(m.vendas) : null,
      preco: m.preco != null ? Number(m.preco) : null,
      at: new Date().toISOString(),
    }) : null;
    const { rows } = await pool.query(
      `INSERT INTO ranking_notes (ranking_ad_id, texto, tipo, baseline)
       VALUES ($1, $2, $3, $4) RETURNING id, texto, tipo, baseline, created_at`,
      [req.params.id, texto.slice(0, 4000), tipo, baseline]
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

// Agendar um aviso de revisão de ADS para o anúncio.
router.post('/ads/:id/alerts', async (req, res) => {
  try {
    const { scheduled_at, message } = req.body;
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at obrigatório' });
    const { rows } = await pool.query(
      `INSERT INTO ranking_ads_alerts (ranking_ad_id, scheduled_at, message, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (ranking_ad_id, scheduled_at) DO UPDATE
           SET message = EXCLUDED.message, updated_at = NOW()
         RETURNING id, ranking_ad_id, scheduled_at, message, notified_at, created_at`,
      [req.params.id, scheduled_at, message || null]
    );
    redis.del('ranking:alerts:*'); // invalida cache
    res.json({ alert: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar alertas agendados para o anúncio.
router.get('/ads/:id/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ranking_ad_id, scheduled_at, message, notified_at, created_at
         FROM ranking_ads_alerts WHERE ranking_ad_id = $1
         ORDER BY scheduled_at DESC`,
      [req.params.id]
    );
    res.json({ alerts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ranking/fase-lote { item_ids: [...] } — estágio atual de vários
// anúncios de uma vez (usado pela tag de estágio em bi-vendas.html e pelo
// agregado "Vendas por Estágio" da Inteligência de Negócio). POST porque a
// lista de item_ids pode passar do limite prático de querystring. Reusa
// ranking.buscarFasePorItemIds — nunca uma 2ª cópia do join.
router.post('/fase-lote', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(String) : [];
    const mapa = await ranking.buscarFasePorItemIds(ids);
    res.json({ fases: Object.fromEntries(mapa) });
  } catch (e) {
    console.error('[api/ranking] fase-lote', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
