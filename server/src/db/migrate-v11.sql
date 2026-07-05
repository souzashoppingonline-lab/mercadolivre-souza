-- v11: coluna refresh_failures para controle de falhas consecutivas de token refresh
ALTER TABLE stores ADD COLUMN IF NOT EXISTS refresh_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS last_refresh_error TEXT;
