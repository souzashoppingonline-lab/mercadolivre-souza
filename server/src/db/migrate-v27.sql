-- v27 — Alerta de tarefa atrasada (Agenda Trello). Ver .claude/decisions.md.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
