-- Migration v7 — imposto_pct per store (tax percentage for margin calculation)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS imposto_pct NUMERIC DEFAULT 0;
