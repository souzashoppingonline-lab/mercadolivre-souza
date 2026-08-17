// Gestão de usuários de acesso restrito (staff) — a tela que substitui o
// script scripts/createStaffUser.js. Ver .claude/auth-staff.md.
//
// SEGURANÇA — por que esta rota mora em /api/usuarios e NÃO em /auth/staff:
// `/auth/*` está em PUBLIC_PREFIXES do requireStaffAuth, ou seja, é acessível
// SEM sessão. Gestão de credenciais aqui seria um buraco aberto. Sob /api ela
// passa pelo gate, e o `requireAdmin` abaixo é a segunda tranca (o gate por si
// só deixa passar qualquer papel que não seja embalagem/shopee-demo).
const express = require('express');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const pool = require('../db/pool');

const router = express.Router();
const PAPEIS = ['admin', 'embalagem', 'shopee-demo'];
const USER_RE = /^[a-z0-9._-]{3,32}$/;
const SENHA_MIN = 6;

// Com o kill switch desligado (STAFF_AUTH_ENABLED=false) não existe sessão
// nenhuma — o sistema inteiro está aberto por decisão de operação, e exigir
// admin aqui só impediria de cadastrar o 1º usuário pela tela. A tela avisa,
// em vermelho, que os papéis não valem enquanto o gate estiver desligado.
function requireAdmin(req, res, next) {
  if (!env.staffAuth.enabled) return next();
  if (req.staffUser?.role === 'admin') return next();
  return res.status(403).json({ error: 'só administradores podem gerenciar usuários' });
}
router.use(requireAdmin);

const normalizaUser = (v) => String(v || '').trim().toLowerCase();

async function totalAdmins(exceptId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM staff_users WHERE role = 'admin' AND id <> $1`,
    [exceptId || 0]
  );
  return rows[0].n;
}

// Lista usuários (NUNCA devolve password_hash) + o estado do gate e quem sou eu,
// pra tela poder desabilitar as ações que travariam o próprio acesso.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, role, created_at FROM staff_users ORDER BY role, username`
    );
    res.json({
      usuarios: rows,
      gate_ativo: !!env.staffAuth.enabled,
      atual: req.staffUser ? { username: req.staffUser.username, role: req.staffUser.role, id: req.staffUser.sub } : null,
      papeis: PAPEIS,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const username = normalizaUser(req.body.username);
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'embalagem');
    if (!USER_RE.test(username)) return res.status(400).json({ error: 'usuário: 3 a 32 caracteres, só letras minúsculas, números, ponto, hífen ou underline' });
    if (password.length < SENHA_MIN) return res.status(400).json({ error: `senha: mínimo de ${SENHA_MIN} caracteres` });
    if (!PAPEIS.includes(role)) return res.status(400).json({ error: 'papel inválido' });

    const existe = await pool.query(`SELECT 1 FROM staff_users WHERE username = $1`, [username]);
    if (existe.rows.length) return res.status(400).json({ error: `já existe um usuário "${username}"` });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO staff_users (username, password_hash, role) VALUES ($1,$2,$3)
       RETURNING id, username, role, created_at`,
      [username, hash, role]
    );
    res.json({ usuario: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Troca senha e/ou papel. Duas travas contra perder o acesso ao sistema:
// ninguém rebaixa a si mesmo, e o último admin não pode deixar de ser admin.
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: alvo } = await pool.query(`SELECT id, username, role FROM staff_users WHERE id = $1`, [id]);
    if (!alvo.length) return res.status(404).json({ error: 'usuário não encontrado' });
    const u = alvo[0];
    const euMesmo = req.staffUser && Number(req.staffUser.sub) === id;

    const sets = [], vals = [id]; let n = 1;
    if (req.body.password != null && req.body.password !== '') {
      const password = String(req.body.password);
      if (password.length < SENHA_MIN) return res.status(400).json({ error: `senha: mínimo de ${SENHA_MIN} caracteres` });
      sets.push(`password_hash = $${++n}`); vals.push(await bcrypt.hash(password, 10));
    }
    if (req.body.role != null && req.body.role !== u.role) {
      const role = String(req.body.role);
      if (!PAPEIS.includes(role)) return res.status(400).json({ error: 'papel inválido' });
      if (u.role === 'admin' && role !== 'admin') {
        if (euMesmo) return res.status(400).json({ error: 'você não pode rebaixar seu próprio usuário — peça a outro admin' });
        if (await totalAdmins(id) === 0) return res.status(400).json({ error: 'este é o último administrador — promova outro antes de mudar o papel deste' });
      }
      sets.push(`role = $${++n}`); vals.push(role);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para alterar' });

    const { rows } = await pool.query(
      `UPDATE staff_users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, role, created_at`, vals
    );
    res.json({ usuario: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: alvo } = await pool.query(`SELECT id, username, role FROM staff_users WHERE id = $1`, [id]);
    if (!alvo.length) return res.status(404).json({ error: 'usuário não encontrado' });
    if (req.staffUser && Number(req.staffUser.sub) === id) {
      return res.status(400).json({ error: 'você não pode excluir o próprio usuário' });
    }
    if (alvo[0].role === 'admin' && await totalAdmins(id) === 0) {
      return res.status(400).json({ error: 'este é o último administrador — crie outro antes de excluir' });
    }
    await pool.query(`DELETE FROM staff_users WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
