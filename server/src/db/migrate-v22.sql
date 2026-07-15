-- v22 — Login de acesso restrito (staff): usuários internos com papel
-- 'admin' (acesso total, comportamento igual a hoje) ou 'embalagem'
-- (só bipagem/vídeo de conferência). Ver .claude/auth-staff.md.
CREATE TABLE IF NOT EXISTS staff_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- admin | embalagem
  created_at TIMESTAMPTZ DEFAULT now()
);
