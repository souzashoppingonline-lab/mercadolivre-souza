// Zera a Agenda Trello (tabela `tasks`) — pedido explícito do usuário pra
// começar do zero com o analista de e-commerce novo. Ver .claude/task-engine.md.
//
// Faz backup em JSON antes de apagar (irreversível, então nunca sem rede de
// segurança) e imprime um resumo antes/depois. `task_comments` cai junto via
// ON DELETE CASCADE (ver database.md) — não precisa apagar à parte.
//
// Regras automáticas (estoque crítico / score baixo) podem recriar cartões
// pra itens que continuam com problema real na próxima vez que rodarem —
// isso é esperado, é o comportamento normal do TaskEngine, não um bug.
//
// Uso (rodar NO SERVIDOR):
//   node server/scripts/zerarAgendaTrello.js
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

async function main() {
  const antes = await pool.query(
    `SELECT board_column, COUNT(*) AS n FROM tasks GROUP BY board_column ORDER BY board_column`
  );
  const total = antes.rows.reduce((s, r) => s + Number(r.n), 0);
  console.log(`Cartões atuais na Agenda Trello: ${total}`);
  antes.rows.forEach((r) => console.log(`   ${r.board_column}: ${r.n}`));

  if (total === 0) {
    console.log('\nJá está zerada — nada a fazer.');
    await pool.end();
    return;
  }

  console.log('\nFazendo backup antes de apagar...');
  const todos = await pool.query(`SELECT * FROM tasks ORDER BY id`);
  const comentarios = await pool.query(`SELECT * FROM task_comments ORDER BY id`);
  const backupDir = path.join(__dirname, '..', 'storage', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `agenda-trello-backup-${stamp}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify({ tasks: todos.rows, task_comments: comentarios.rows }, null, 2)
  );
  console.log(`Backup salvo em: ${backupFile} (${todos.rows.length} cartões, ${comentarios.rows.length} comentários)`);

  const del = await pool.query(`DELETE FROM tasks`);
  console.log(`\n✅ ${del.rowCount} cartão(ões) apagado(s) (comentários caíram junto). Agenda Trello zerada.`);
  console.log('Obs: cartões automáticos (estoque crítico / score baixo) podem reaparecer sozinhos na próxima checagem, só pra itens que continuam com problema real agora — não é bug.');

  await pool.end();
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
