-- v13: add original_price to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS original_price NUMERIC DEFAULT 0;
