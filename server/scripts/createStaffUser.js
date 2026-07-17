// Cria (ou atualiza a senha de) um usuário de staff. Não existe UI de
// gerenciamento de usuários ainda — este é o único jeito de criar o 1º
// admin, os usuários 'embalagem' dos funcionários, e contas 'shopee-demo'
// (acesso restrito a dashboard-shopee.html, pra revisor externo). Ver
// .claude/auth-staff.md.
//
// Uso:
//   node server/scripts/createStaffUser.js <username> <senha> [admin|embalagem|shopee-demo]
//
// role é opcional, default 'admin'. Rodar de novo com o mesmo username
// atualiza a senha (e o role, se informado) do usuário existente.
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

async function main() {
  const [username, password, role = 'admin'] = process.argv.slice(2);

  if (!username || !password) {
    console.error('Uso: node server/scripts/createStaffUser.js <username> <senha> [admin|embalagem|shopee-demo]');
    process.exit(1);
  }
  if (!['admin', 'embalagem', 'shopee-demo'].includes(role)) {
    console.error(`role inválido: "${role}" — use "admin", "embalagem" ou "shopee-demo"`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO staff_users (username, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
     RETURNING id, username, role`,
    [username, hash, role]
  );

  console.log(`Usuário "${rows[0].username}" (role: ${rows[0].role}) salvo com sucesso — id ${rows[0].id}.`);
  await pool.end();
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
