-- v68 — Cache das medidas da caixa (embalagem) por item. O worker preenche no
-- sync do item (já busca o item via getItem, custo zero), pra a página Embalagem
-- ler do banco no bipe — SEM GET no ML (imune a rate limit). Ver .claude/embalagem.md.
ALTER TABLE items ADD COLUMN IF NOT EXISTS package_dims JSONB;
