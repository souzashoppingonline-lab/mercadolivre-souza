-- v48: rede de segurança para o tipo de seller_product_rebate (JSONB).
-- Redundante com o DO-block do v44 — só age se, por algum estado antigo, a coluna
-- ainda estiver como NUMERIC. NÃO usa USING NULL incondicional (isso apagaria o que
-- o v44 acabou de gravar); o guard garante que só converte quando o tipo está errado.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shopee_order_data'
      AND column_name = 'seller_product_rebate'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE shopee_order_data ALTER COLUMN seller_product_rebate TYPE JSONB USING NULL;
  END IF;
END $$;
