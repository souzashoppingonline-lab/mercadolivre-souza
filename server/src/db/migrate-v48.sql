-- v48: corrigir tipo de seller_product_rebate de NUMERIC → JSONB
-- O banco em produção pode ter a coluna com tipo errado; corrige para o tipo correto

ALTER TABLE shopee_order_data
  ALTER COLUMN seller_product_rebate TYPE JSONB USING NULL;
