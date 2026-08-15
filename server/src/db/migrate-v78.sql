-- v78: Nível de progressão do anúncio em RANQUEADO.
-- Nível = 1 + FLOOR(sales_count / 10) — calculado no backend (routes/ranking.js);
-- a coluna existe para uso futuro/consulta direta.
--
-- REESCRITA (v80): o conteúdo original deste arquivo estava na notação abreviada
-- da documentação (`id SERIAL PK`, `ranking_ad_id INT NOT NULL FK ...`), que NÃO é
-- SQL válido. Como o migrate.js envia o arquivo inteiro em um único pool.query, o
-- erro de parse rejeitava o batch todo e NADA da v78 era aplicado — nem esta coluna.
-- A tabela `ranking_return_issues` que existia aqui foi removida de propósito:
-- nenhum código a lê ou escreve (o card mostra devoluções como 0 fixo), então
-- criá-la seria schema morto. Se um dia for necessária, criar em migration nova
-- com SQL válido. Ver known-bugs.md.

ALTER TABLE ranking_ads ADD COLUMN IF NOT EXISTS nivel INT DEFAULT 1;
