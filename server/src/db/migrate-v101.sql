-- v101 — Observação de Embalagem: frase livre cadastrada por produto (página
-- Produtos, modal de detalhe), mostrada como alerta na hora do bipe quando
-- preenchida. NULL = sem observação cadastrada (não mostra nada no bipe,
-- pedido explícito do usuário). Campo genérico em `items` (não amarrado a
-- marketplace) — hoje só o modal ML (pages/produtos.html) tem UI pra editar,
-- mas o dado/leitura já cobre também item Shopee, ver .claude/embalagem.md.
ALTER TABLE items ADD COLUMN IF NOT EXISTS observacao_embalagem TEXT;
