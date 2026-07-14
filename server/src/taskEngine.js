// TaskEngine — lógica centralizada de geração automática de cartões da Agenda
// Trello. Nenhuma página/worker deve montar um INSERT em `tasks` diretamente;
// tudo passa por aqui. Ver .claude/task-engine.md para a arquitetura completa.
const pool = require('./db/pool');

// Mesmo limiar já usado em handleItem() pro alerta Telegram tg_reposicao —
// reaproveitado aqui em vez de criar um novo threshold configurável, já que
// o módulo é independente mas a regra de negócio ("estoque crítico") é a
// mesma que o sistema já usa.
const STOCK_CRITICAL_THRESHOLD = 5;
const QUALITY_SCORE_THRESHOLD = 50;

let mlMarketplaceIdCache = null;
async function getMlMarketplaceId() {
  if (mlMarketplaceIdCache) return mlMarketplaceIdCache;
  const { rows } = await pool.query(`SELECT id FROM marketplaces WHERE code='ML'`);
  mlMarketplaceIdCache = rows[0]?.id ?? null;
  return mlMarketplaceIdCache;
}

// Dedup: se já existe cartão para essa regra+item em QUALQUER status que não
// seja excluído (a_fazer, em_andamento ou até finalizado), só atualiza a
// data/metadata em vez de duplicar. Só volta a criar um cartão novo depois
// que o anterior for movido pra Excluído.
async function createTaskIfNotExists({ ruleKey, itemId, title, description, priority, storeId, source = 'mercado_livre', metadata = {} }) {
  const marketplaceId = await getMlMarketplaceId();
  const { rows: existing } = await pool.query(
    `SELECT id FROM tasks WHERE rule_key=$1 AND item_id=$2 AND board_column != 'excluido' LIMIT 1`,
    [ruleKey, itemId]
  );
  if (existing.length) {
    await pool.query(`UPDATE tasks SET updated_at=now(), metadata=$2 WHERE id=$1`, [existing[0].id, JSON.stringify(metadata)]);
    return { id: existing[0].id, created: false };
  }
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, board_column, priority, marketplace_id, store_id, item_id, source, rule_key, metadata)
     VALUES ($1,$2,'a_fazer',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [title, description, priority, marketplaceId, storeId, itemId, source, ruleKey, JSON.stringify(metadata)]
  );
  return { id: rows[0].id, created: true };
}

// Regra 1 — Estoque crítico. Chamada de handleItem() em worker.js.
async function checkStock({ itemId, title, availableQuantity, permalink, storeId, storeName }) {
  if (availableQuantity == null || availableQuantity > STOCK_CRITICAL_THRESHOLD) return null;
  try {
    return await createTaskIfNotExists({
      ruleKey: 'estoque_critico',
      itemId,
      title: `Repor estoque urgente: ${title || itemId}`,
      description: `O anúncio ${itemId} atingiu estoque crítico (restam ${availableQuantity} un.).`,
      priority: 'alta',
      storeId,
      metadata: {
        sku: itemId, titulo: title, quantidade: availableQuantity,
        loja: storeName, marketplace: 'Mercado Livre', link: permalink,
      },
    });
  } catch (e) {
    console.warn(`[task-engine] checkStock falhou para ${itemId}: ${e.message}`);
    return null;
  }
}

// Regra 2 — Score de qualidade abaixo de 50. Chamada de syncScores() em worker.js.
async function checkQuality({ itemId, title, score, problems, permalink, storeId, storeName }) {
  if (score == null || score >= QUALITY_SCORE_THRESHOLD) return null;
  try {
    return await createTaskIfNotExists({
      ruleKey: 'score_baixo',
      itemId,
      title: `Melhorar qualidade: ${title || itemId}`,
      description: `O anúncio possui qualidade abaixo de 50 (score atual: ${score}).`,
      priority: 'media',
      storeId,
      metadata: {
        scoreAtual: score, problemas: problems || [],
        loja: storeName, marketplace: 'Mercado Livre', link: permalink, titulo: title,
      },
    });
  } catch (e) {
    console.warn(`[task-engine] checkQuality falhou para ${itemId}: ${e.message}`);
    return null;
  }
}

module.exports = { checkStock, checkQuality, createTaskIfNotExists };
