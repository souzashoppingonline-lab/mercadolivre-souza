-- Views ML-only — resolve known-bugs.md #7: routes/api.js lia orders/items/
-- stores sem filtrar marketplace_id, então pedidos/lojas de outros
-- marketplaces (Amazon) apareciam misturados nos KPIs/relatórios/telas do
-- ML (confirmado em produção: um pedido de teste chegou a somar no card
-- "vendas hoje", e a store sentinela da Amazon aparecia na página Lojas com
-- um botão "Reconectar loja" que não faz sentido pra ela).
--
-- Em vez de editar dezenas de queries em api.js uma a uma (alto risco de
-- esquecer alguma ou quebrar sintaxe), as telas existentes (construídas só
-- para o ML) passam a ler dessas views em vez das tabelas diretamente.
-- Views simples de tabela única + WHERE são automaticamente "updatable" no
-- Postgres, mas api.js só usa essas views para LEITURA (SELECT/JOIN) — os
-- poucos UPDATEs que existem (custo, imposto, frete vendedor) continuam
-- direto nas tabelas reais, escopados por ID específico, sem risco.
--
-- Nomeadas vw_ml_orders/vw_ml_items/vw_ml_stores (prefixo vw_) e não
-- ml_orders/ml_items — essa primeira tentativa colidiu em produção com
-- tabelas REAIS e populadas (592 + 86 linhas) do sistema antigo
-- (ml-dashboard.service, ver deployment.md/roadmap.md "Transição do Sistema
-- Antigo"), que usa esse mesmo prefixo por coincidência com um schema
-- totalmente diferente (order_id/seller_id/raw_json). CREATE OR REPLACE VIEW
-- falhou em cima delas (`"ml_orders" is not a view`) — o que é o
-- comportamento correto do Postgres: nunca teria sobrescrito os dados, mas
-- o nome precisa ser trocado para não colidir de novo no futuro.
--
-- Quando o dashboard multi-marketplace de verdade for construído (ver
-- roadmap.md), essas views deixam de ser usadas nas queries que devem
-- mostrar todos os marketplaces juntos.
CREATE OR REPLACE VIEW vw_ml_orders AS
  SELECT * FROM orders
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW vw_ml_items AS
  SELECT * FROM items
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;

CREATE OR REPLACE VIEW vw_ml_stores AS
  SELECT * FROM stores
  WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'ML') OR marketplace_id IS NULL;
