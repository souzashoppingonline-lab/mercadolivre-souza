-- v19 — Agenda Trello: módulo de tarefas (Kanban) totalmente independente do
-- resto do sistema. Tabela própria, sem tocar em orders/items/stores. Ver
-- .claude/task-engine.md para a arquitetura completa do TaskEngine.
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  -- a_fazer | em_andamento | finalizado | excluido — nome de coluna evitado
  -- por ser palavra reservada-ish em SQL.
  board_column TEXT NOT NULL DEFAULT 'a_fazer',
  priority TEXT NOT NULL DEFAULT 'media', -- alta | media | baixa
  marketplace_id INT REFERENCES marketplaces(id),
  store_id BIGINT REFERENCES stores(id),
  -- Referência solta ao anúncio (não FK) — a tarefa deve sobreviver mesmo se
  -- o item for removido/alterado depois; item_id aqui é o mesmo valor de
  -- items.ml_id/orders.item_id, só sem constraint de integridade.
  item_id TEXT,
  source TEXT NOT NULL DEFAULT 'sistema', -- mercado_livre | amazon | shopee | sistema | manual
  -- Chave da regra que gerou o cartão (ex: 'estoque_critico', 'score_baixo')
  -- — usada pelo TaskEngine pra deduplicar; NULL em tarefas manuais.
  rule_key TEXT,
  status TEXT NOT NULL DEFAULT 'aberto', -- aberto | concluido
  tags TEXT[] DEFAULT '{}',
  assigned_to TEXT,
  due_date TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_board_column ON tasks(board_column);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_store ON tasks(store_id);
-- Dedup do TaskEngine: acha rápido "já existe cartão aberto pra essa
-- regra+item?" sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_tasks_rule_item_open ON tasks(rule_key, item_id) WHERE board_column NOT IN ('finalizado', 'excluido');

CREATE TABLE IF NOT EXISTS task_comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
