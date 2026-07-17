// Agenda Trello — API do quadro Kanban. Módulo 100% independente: só lê/
// grava a tabela `tasks`/`task_comments` (migration v19), nunca toca em
// orders/items. Geração automática de cartões fica em ../taskEngine.js —
// esta rota só expõe CRUD + filtros pro frontend. Ver .claude/task-engine.md.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const VALID_COLUMNS = ['a_fazer', 'em_andamento', 'finalizado', 'excluido'];
const VALID_PRIORITIES = ['alta', 'media', 'baixa'];

// Envia direto (mesmo padrão de POST /api/config/telegram/test em routes/api.js
// — rota HTTP não tem acesso ao tgNotify() de worker.js). Não respeita janela
// de silêncio/intervalo (mesmo espírito de tgNotifyForce): é uma ação humana
// deliberada e rara, não um alerta automático que possa virar spam. Só respeita
// o toggle liga/desliga (tg_tarefas), reaproveitado do alerta de atraso — ambos
// são notificações da Agenda Trello.
async function tgNotifyTaskDeleted(text) {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [['telegram_bot_token', 'telegram_chat_id', 'tg_tarefas']]
    );
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const token = cfg.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = cfg.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    if (cfg.tg_tarefas === 'false') return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[api/tasks] tgNotifyTaskDeleted erro:', e.message); }
}

router.get('/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE board_column != 'excluido') AS total,
         COUNT(*) FILTER (WHERE board_column = 'a_fazer') AS pendentes,
         COUNT(*) FILTER (WHERE board_column = 'em_andamento') AS em_andamento,
         COUNT(*) FILTER (WHERE board_column = 'finalizado' AND completed_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS finalizadas_hoje,
         COUNT(*) FILTER (WHERE priority = 'alta' AND board_column NOT IN ('finalizado','excluido')) AS criticas,
         COUNT(*) FILTER (WHERE due_date < now() AND board_column NOT IN ('finalizado','excluido')) AS atrasadas
       FROM tasks`
    );
    const r = rows[0];
    res.json({
      total: Number(r.total), pendentes: Number(r.pendentes),
      em_andamento: Number(r.em_andamento), finalizadas_hoje: Number(r.finalizadas_hoje),
      criticas: Number(r.criticas), atrasadas: Number(r.atrasadas),
    });
  } catch (e) {
    console.error('[api/tasks] /summary', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { marketplace, store_id, assigned_to, priority, source, board_column, date_from, date_to } = req.query;
    const where = [];
    const params = [];
    if (marketplace) { params.push(marketplace); where.push(`m.code = $${params.length}`); }
    if (store_id) { params.push(store_id); where.push(`t.store_id = $${params.length}`); }
    if (assigned_to) { params.push(assigned_to); where.push(`t.assigned_to = $${params.length}`); }
    if (priority) { params.push(priority); where.push(`t.priority = $${params.length}`); }
    if (source) { params.push(source); where.push(`t.source = $${params.length}`); }
    if (board_column) { params.push(board_column); where.push(`t.board_column = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`t.created_at >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`t.created_at <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.description, t.board_column, t.priority, t.item_id,
              t.source, t.rule_key, t.status, t.tags, t.assigned_to, t.due_date,
              t.metadata, t.created_at, t.updated_at, t.completed_at,
              t.store_id, s.nickname AS store_nickname,
              t.marketplace_id, m.code AS marketplace_code, m.name AS marketplace_name,
              (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
              (SELECT tc.text FROM task_comments tc WHERE tc.task_id = t.id ORDER BY tc.created_at DESC LIMIT 1) AS last_comment_text,
              (SELECT tc.created_at FROM task_comments tc WHERE tc.task_id = t.id ORDER BY tc.created_at DESC LIMIT 1) AS last_comment_at
       FROM tasks t
       LEFT JOIN stores s ON s.id = t.store_id
       LEFT JOIN marketplaces m ON m.id = t.marketplace_id
       ${whereSql}
       ORDER BY t.priority = 'alta' DESC, t.created_at DESC`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/tasks] GET /', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, description, marketplace, store_id, priority, due_date, assigned_to, tags } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title é obrigatório' });
    const finalPriority = VALID_PRIORITIES.includes(priority) ? priority : 'media';

    let marketplaceId = null;
    if (marketplace) {
      const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code = $1`, [marketplace]);
      marketplaceId = rows[0]?.id ?? null;
    }

    const { rows } = await pool.query(
      `INSERT INTO tasks (title, description, board_column, priority, marketplace_id, store_id, source, tags, assigned_to, due_date)
       VALUES ($1,$2,'a_fazer',$3,$4,$5,'manual',$6,$7,$8) RETURNING id`,
      [title, description || null, finalPriority, marketplaceId, store_id || null, tags || [], assigned_to || null, due_date || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    console.error('[api/tasks] POST /', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { board_column, title, description, priority, assigned_to, due_date, tags } = req.body || {};

    const sets = [];
    const params = [];
    if (board_column !== undefined) {
      if (!VALID_COLUMNS.includes(board_column)) return res.status(400).json({ error: 'board_column inválido' });
      params.push(board_column); sets.push(`board_column = $${params.length}`);
      if (board_column === 'finalizado') {
        sets.push(`status = 'concluido'`, `completed_at = now()`);
      } else {
        sets.push(`status = 'aberto'`, `completed_at = NULL`);
      }
    }
    if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
    if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
    if (priority !== undefined) {
      if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'priority inválida' });
      params.push(priority); sets.push(`priority = $${params.length}`);
    }
    if (assigned_to !== undefined) { params.push(assigned_to); sets.push(`assigned_to = $${params.length}`); }
    // Prazo mudou (adiado ou removido) — reseta o "já notificado" pra poder
    // alertar de novo se a nova data também passar (ver checkTarefasAtrasadas).
    if (due_date !== undefined) { params.push(due_date); sets.push(`due_date = $${params.length}`, `overdue_notified_at = NULL`); }
    if (tags !== undefined) { params.push(tags); sets.push(`tags = $${params.length}`); }

    if (!sets.length) return res.status(400).json({ error: 'nenhum campo para atualizar' });
    sets.push(`updated_at = now()`);
    params.push(id);

    const { rowCount } = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (!rowCount) return res.status(404).json({ error: 'tarefa não encontrada' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/tasks] PATCH /:id', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Exclusão definitiva — só permitida quando o cartão já está na coluna
// Excluído (soft-delete via board_column vem antes; isto aqui é o hard
// delete, chamado só a partir dela). task_comments cai junto via
// ON DELETE CASCADE. Antes de apagar, manda os detalhes completos pro
// Telegram — depois do DELETE não sobra rastro nenhum no banco.
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.description, t.priority, t.tags, t.assigned_to,
              t.source, t.created_at, t.board_column, s.nickname AS store_nickname,
              m.name AS marketplace_name
       FROM tasks t
       LEFT JOIN stores s ON s.id = t.store_id
       LEFT JOIN marketplaces m ON m.id = t.marketplace_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'tarefa não encontrada' });
    const t = rows[0];
    if (t.board_column !== 'excluido') {
      return res.status(400).json({ error: 'só é possível excluir definitivamente um cartão que já está na coluna Excluído' });
    }

    // Notifica antes de apagar — se o Telegram falhar, não bloqueia a exclusão
    // (mesmo princípio de "notificação nunca trava operação principal" já
    // usado no resto do sistema, ver decisions.md).
    const criado = new Date(t.created_at).toLocaleDateString('pt-BR');
    await tgNotifyTaskDeleted(
      `🗑️ <b>Cartão excluído definitivamente</b>\n\n` +
      `<b>${t.title}</b>\n` +
      (t.description ? `${t.description}\n\n` : '\n') +
      `Prioridade: ${t.priority}\n` +
      (t.store_nickname ? `Loja: ${t.store_nickname}\n` : '') +
      (t.marketplace_name ? `Marketplace: ${t.marketplace_name}\n` : '') +
      (t.assigned_to ? `Responsável: ${t.assigned_to}\n` : '') +
      (t.tags?.length ? `Tags: ${t.tags.join(', ')}\n` : '') +
      `Origem: ${t.source}\n` +
      `Criado em: ${criado}`
    );

    await pool.query(`DELETE FROM tasks WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/tasks] DELETE /:id', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, author, text, created_at FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/tasks] GET /:id/comments', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/comments', async (req, res) => {
  try {
    const { author, text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text é obrigatório' });
    const { rows } = await pool.query(
      `INSERT INTO task_comments (task_id, author, text) VALUES ($1,$2,$3) RETURNING id, author, text, created_at`,
      [req.params.id, author || null, text]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[api/tasks] POST /:id/comments', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
