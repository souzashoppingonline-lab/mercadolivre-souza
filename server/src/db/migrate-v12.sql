-- v12: tabela schedule_runs para histórico de execuções dos syncs
CREATE TABLE IF NOT EXISTS schedule_runs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  status TEXT,
  report JSONB,
  error_msg TEXT
);
CREATE INDEX IF NOT EXISTS schedule_runs_job ON schedule_runs(job_name, started_at DESC);
