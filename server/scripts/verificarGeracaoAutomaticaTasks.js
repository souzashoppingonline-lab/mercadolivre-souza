// Verifica se o TaskEngine está gerando cards automáticos normalmente (após
// zerar a Agenda Trello) — reproduz as MESMAS condições de checkStock()/
// checkQuality() (server/src/taskEngine.js) fora do worker, comparando com
// os cartões que já existem em `tasks`. Ver .claude/task-engine.md.
//
// Importante: as regras não são "verificadas" em loop — cada uma só dispara
// quando o gatilho dela acontece:
//   - estoque_critico: a cada webhook `items` do ML (tempo real, handleItem)
//   - score_baixo: 1x por dia, no job syncScores (01:00)
// Então um item que já qualifica mas ainda não tem card pode só estar
// esperando o próximo gatilho — não é necessariamente falha.
//
// Uso (rodar NO SERVIDOR):
//   node server/scripts/verificarGeracaoAutomaticaTasks.js
const pool = require('../src/db/pool');

const STOCK_CRITICAL_THRESHOLD = 5;
const QUALITY_SCORE_THRESHOLD = 50;

async function main() {
  console.log('Verificando geração automática de cards na Agenda Trello...\n');

  // 0. Estado atual do quadro, por regra/origem.
  const atual = await pool.query(
    `SELECT COALESCE(rule_key, '(manual/sem regra)') AS regra, board_column, COUNT(*) AS n
       FROM tasks GROUP BY regra, board_column ORDER BY regra, board_column`
  );
  console.log(`0. Cards existentes agora: ${atual.rows.reduce((s, r) => s + Number(r.n), 0)}`);
  atual.rows.forEach(r => console.log(`   regra=${r.regra} coluna=${r.board_column}: ${r.n}`));

  // 1. Quando rodou a última vez o job diário que dispara checkQuality.
  const job = await pool.query(
    `SELECT name, last_run, status FROM schedule_jobs WHERE name = 'syncScores'`
  );
  if (job.rows.length) {
    console.log(`\n1. Último job syncScores (dispara checkQuality, 1x/dia às 01:00): last_run=${job.rows[0].last_run} status=${job.rows[0].status}`);
  } else {
    console.log(`\n1. Nenhum registro de job "syncScores" em schedule_jobs ainda.`);
  }

  // 2. Itens com estoque crítico (mesma condição de checkStock) SEM card aberto.
  const semCardEstoque = await pool.query(
    `SELECT i.ml_id, i.title, i.available_quantity, i.store_id, s.nickname
       FROM items i
       LEFT JOIN stores s ON s.id = i.store_id
      WHERE i.available_quantity IS NOT NULL AND i.available_quantity <= $1
        AND i.marketplace_id = (SELECT id FROM marketplaces WHERE code='ML')
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.rule_key = 'estoque_critico' AND t.item_id = i.ml_id AND t.board_column != 'excluido'
        )
      ORDER BY i.available_quantity ASC LIMIT 15`,
    [STOCK_CRITICAL_THRESHOLD]
  );
  console.log(`\n2. Itens ML com estoque <= ${STOCK_CRITICAL_THRESHOLD} SEM card aberto de 'estoque_critico': ${semCardEstoque.rows.length}`);
  semCardEstoque.rows.forEach(r => console.log(`   ${r.ml_id} "${r.title}" qtd=${r.available_quantity} loja=${r.nickname}`));
  if (semCardEstoque.rows.length) {
    console.log('   → normal se nenhum webhook `items` chegou pra esses anúncios desde o reset; o próximo webhook (ex.: alteração de preço/estoque) gera o card.');
  }

  // 3. Itens com score < 50 (mesma condição de checkQuality) SEM card aberto.
  const semCardScore = await pool.query(
    `SELECT p.item_id, i.title, p.score, i.store_id, s.nickname
       FROM item_performance p
       JOIN items i ON i.ml_id = p.item_id
       LEFT JOIN stores s ON s.id = i.store_id
      WHERE p.score IS NOT NULL AND p.score < $1
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.rule_key = 'score_baixo' AND t.item_id = p.item_id AND t.board_column != 'excluido'
        )
      ORDER BY p.score ASC LIMIT 15`,
    [QUALITY_SCORE_THRESHOLD]
  );
  console.log(`\n3. Itens ML com score < ${QUALITY_SCORE_THRESHOLD} SEM card aberto de 'score_baixo': ${semCardScore.rows.length}`);
  semCardScore.rows.forEach(r => console.log(`   ${r.item_id} "${r.title}" score=${r.score} loja=${r.nickname}`));
  if (semCardScore.rows.length) {
    console.log('   → normal se o job syncScores (01:00) ainda não rodou desde o reset; roda 1x por dia, não em tempo real.');
  }

  // 4. Cards automáticos criados DEPOIS do reset (prova positiva de que o
  // TaskEngine está de fato criando cards novos, não só "não tem nada").
  const criadosRecente = await pool.query(
    `SELECT id, rule_key, item_id, title, created_at FROM tasks
      WHERE rule_key IS NOT NULL ORDER BY created_at DESC LIMIT 10`
  );
  console.log(`\n4. Últimos ${criadosRecente.rows.length} cards automáticos criados (mais recentes primeiro):`);
  criadosRecente.rows.forEach(r => console.log(`   #${r.id} regra=${r.rule_key} item=${r.item_id} "${r.title}" criado=${r.created_at}`));

  console.log('\nResumo: se (2)/(3) vierem vazios ou pequenos, e (4) mostrar cards recentes, o TaskEngine está funcionando normal — só gera card quando o gatilho (webhook/job diário) roda, não é instantâneo pra todo o catálogo de uma vez.');

  await pool.end();
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
