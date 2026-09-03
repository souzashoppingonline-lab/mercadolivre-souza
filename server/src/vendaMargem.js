// SELECT + fórmula de margem por pedido — fonte única, usada por:
//  - routes/api.js (`GET /vendas/detalhado`, listagem)
//  - routes/bi.js (`GET /bi/margem`, Inteligência de Margem — agrega por item_id)
//  - financeService.js (reconciliação, devolve a linha recalculada depois de
//    atualizar tarifa/frete)
// Extraído pra módulo próprio (v82) quando um 4º consumidor apareceu — antes
// vivia dentro de routes/api.js e era exportado como propriedade do router
// (funcionava, mas ficava estranho fora de rota). Nunca duplicar esta fórmula
// em outro lugar — ver finance.md.
const pool = require('./db/pool');

// Conciliação Bancária (mp_account_movements, description='Payment') — tarifa
// real e frete do vendedor real por pedido. Precisa que a query externa
// aliaseie o pedido como `o` (usa `o.ml_id` e `o.shipping_cost`). Extraída
// pra constante porque a MESMA subquery vivia duplicada em 4 arquivos
// (aqui, routes/api.js × 2, reports.js) — nunca uma 2ª cópia da fórmula.
//
// Proteção contra frete do comprador contado como tarifa (bug real
// reportado pelo usuário, produto MLB7037761594): quando o pedido tem
// MAIS DE UMA linha 'Payment' na Conciliação (raro — a maioria tem 1), o
// relatório de liberação do Mercado Pago às vezes traz uma linha extra
// pro repasse do frete pago pelo comprador, com o valor inteiro caindo na
// coluna MP_FEE_AMOUNT (nada em SHIPPING_FEE_AMOUNT) — a tarifa aparecia
// R$9,83 (comissão real R$4,83 + frete do comprador R$5,00 somados por
// engano, ao invés dos R$4,83 que o próprio Mercado Livre cobra). Zerada
// só quando as 3 condições batem: (1) há mais de 1 linha Payment pro
// pedido, (2) o valor da linha é EXATAMENTE igual ao frete pago pelo
// comprador (`o.shipping_cost`), e (3) essa linha não tem frete do
// vendedor próprio — combinação específica o bastante pra não arriscar
// zerar uma comissão real por coincidência de centavos numa venda de
// linha única (o caso comum). `mp_fee_amount`/`shipping_fee_amount` vêm
// negativos do relatório (débito), por isso `ABS()` na comparação com
// `o.shipping_cost` (sempre positivo). Lógica validada num Postgres local
// com dados sintéticos reproduzindo o cenário (4 casos: bug real, pedido
// normal de 1 linha, 2 linhas legítimas sem coincidência, 1 linha única
// que bate por coincidência — só o 1º caso zera) — não confirmado contra
// o extrato real de produção (sem acesso ao Postgres de produção nesta
// tarefa); se a hipótese estiver errada, ver `known-bugs.md`.
const CONCILIACAO_TARIFA_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT ABS(SUM(mm.mp_fee_amount)) AS tarifa_real,
              ABS(SUM(mm.shipping_fee_amount)) AS frete_vend_real
       FROM (
         SELECT
           CASE WHEN COUNT(*) OVER () > 1
                     AND ABS(m.mp_fee_amount) = o.shipping_cost
                     AND COALESCE(m.shipping_fee_amount, 0) = 0
                THEN 0 ELSE m.mp_fee_amount END AS mp_fee_amount,
           m.shipping_fee_amount
         FROM mp_account_movements m
         WHERE m.order_id = o.ml_id AND m.description = 'Payment'
       ) mm
     ) c ON true`;

const VENDA_DETALHE_SELECT = `
     SELECT
       o.ml_id, o.store_id, s.nickname as conta, o.item_id,
       o.title, o.quantity, o.unit_price,
       o.total_amount as faturamento,
       o.buyer_nickname,
       -- Tela "Resumo por venda" (card BI): campos que só existem dentro do
       -- payload cru do pedido — não valia coluna própria só pra isso.
       -- Nome real do comprador nem sempre vem preenchido pelo ML.
       o.raw_data->'buyer'->>'first_name' as buyer_first,
       o.raw_data->'buyer'->>'last_name' as buyer_last,
       o.raw_data->>'pack_id' as pack_id,
       COALESCE(
         o.raw_data->'order_items'->0->'item'->>'seller_sku',
         o.raw_data->'order_items'->0->'item'->>'seller_custom_field'
       ) as sku,
       i.thumbnail, i.available_quantity as estoque_atual, i.category_id,
       -- tarifa_manual (v84, botão "editar tarifa" em bi-vendas.html) tem
       -- precedência sobre TUDO — é o escape hatch pra quando a Conciliação
       -- vem errada e CONCILIACAO_TARIFA_LATERAL não pega o caso (ver
       -- business-rules.md/known-bugs.md).
       CASE WHEN o.tarifa_manual IS NOT NULL THEN o.tarifa_manual
            WHEN c.tarifa_real IS NOT NULL THEN c.tarifa_real
            WHEN pg.taxa_pgto IS NOT NULL THEN pg.taxa_pgto - LEAST(COALESCE(o.shipping_seller_cost,0), pg.taxa_pgto)
            ELSE COALESCE(o.ml_fee, 0) END as tarifa,
       o.shipping_type as frete_tipo,
       o.shipping_cost as frete_comprador,
       -- frete_vendedor_manual (v86, botão "editar frete" em bi-vendas.html)
       -- tem precedência sobre TUDO, inclusive a substituição do custo
       -- motoboy Flex abaixo — mesmo escape hatch de tarifa_manual (v84).
       CASE WHEN o.frete_vendedor_manual IS NOT NULL THEN o.frete_vendedor_manual
            WHEN c.tarifa_real IS NOT NULL THEN COALESCE(c.frete_vend_real, 0)
            WHEN pg.taxa_pgto IS NOT NULL THEN LEAST(COALESCE(o.shipping_seller_cost,0), pg.taxa_pgto)
            ELSE COALESCE(o.shipping_seller_cost, 0) END as frete_vendedor,
       o.frete_vendedor_manual as frete_vendedor_manual,
       (c.tarifa_real IS NOT NULL) as tem_conciliacao,
       CASE WHEN o.tarifa_manual IS NOT NULL THEN 'manual'
            WHEN c.tarifa_real IS NOT NULL THEN 'conciliacao'
            WHEN pg.taxa_pgto IS NOT NULL THEN 'pagamento'
            ELSE 'pedido' END as fonte_taxa,
       CASE WHEN o.frete_vendedor_manual IS NOT NULL THEN 'manual'
            WHEN c.tarifa_real IS NOT NULL THEN 'conciliacao'
            WHEN pg.taxa_pgto IS NOT NULL THEN 'pagamento'
            ELSE 'pedido' END as fonte_frete,
       o.status, o.date_created,
       o.finance_synced, o.last_finance_sync_at,
       COALESCE(o.shipping_seller_reembolso, 0) as frete_vendedor_reembolso,
       COALESCE(i.cost, 0) as custo,
       -- Distingue "custo não cadastrado" de "custo é R$0,00 mesmo" — o
       -- COALESCE acima já achata os dois em 0 pro cálculo de margem (não dá
       -- pra mudar isso sem afetar margem/mc_pct de todo mundo que já
       -- consome essa query), então o front usa ESTA flag separada só pra
       -- decidir se avisa visualmente. 'i.cost IS NULL' cobre os dois casos
       -- reais: item sem custo preenchido, e item ainda nem sincronizado
       -- (LEFT JOIN sem match, item inteiro NULL).
       (i.cost IS NULL) as custo_ausente,
       COALESCE(s.imposto_pct, 0) as imposto_pct
     FROM vw_ml_orders o
     JOIN vw_ml_stores s ON s.id = o.store_id
     LEFT JOIN vw_ml_items i ON i.ml_id = o.item_id
     ${CONCILIACAO_TARIFA_LATERAL}
     LEFT JOIN LATERAL (
       SELECT NULLIF(GREATEST(SUM(p.transaction_amount) - SUM(p.net_received_amount), 0), 0) AS taxa_pgto
       FROM ml_payments p
       WHERE p.order_id = o.ml_id AND p.net_received_amount IS NOT NULL
         AND p.status = 'approved'
     ) pg ON true`;

// Vendas Flex (shipping_type='self_service') não têm nota fiscal emitida
// (pedido explícito do usuário) — por padrão o imposto não é cobrado nelas.
// Flag GERAL (não por loja), key/value em app_config (mesmo padrão de
// tg_*/email_*), lida 1x por request pelo chamador e passada adiante —
// calcularMargemLinha continua síncrona/pura, sem I/O escondido.
async function buscarImpostoFlexAtivo() {
  const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='imposto_flex_ativo'`);
  return rows[0]?.value === 'true';
}

// Custo real de entrega via motoboy terceirizado (RR Express/Pex Entregas,
// ambas cobrando o mesmo valor hoje — pedido explícito do usuário), usado
// como frete do vendedor nas vendas Flex EM VEZ do que a API do ML mostra
// (investigado ao vivo: o vendedor normalmente não é cobrado nada pelo ML
// no Flex — ver business-rules.md "Frete Flex — subsídio ao comprador, não
// ao vendedor"). Flag GERAL (não por loja/transportadora) + valor editável,
// mesmo padrão de app_config de imposto_flex_ativo. Desligada por padrão.
async function buscarFreteMotoboy() {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_config WHERE key IN ('frete_motoboy_ativo', 'frete_motoboy_valor')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { ativo: map.frete_motoboy_ativo === 'true', valor: Number(map.frete_motoboy_valor) || 12.90 };
}

// Aplica a fórmula de margem (finance.md) em cima de 1 linha crua da query
// acima. Nunca duas fórmulas de margem no projeto.
// `impostoFlexAtivo` (default false = comportamento padrão do sistema):
// quando false, vendas Flex sempre entram com imposto=0, independente do
// imposto_pct configurado na loja (ver business-rules.md).
// `freteMotoboy` ({ativo, valor} ou null/undefined = desligado): quando
// ativo, vendas Flex usam `valor` (fixo, editável) MENOS o que o ML de fato
// reembolsar ao vendedor (`frete_vendedor_reembolso` — quase sempre 0 em
// toda amostra real testada, mas a extração já cobre o caso de não ser),
// no lugar do frete_vendedor que vem da Conciliação/ml_fee/etc — nunca soma
// aos dois, substitui (custo real de quem entrega de fato a mercadoria).
// Nunca fica negativo (Math.max(0, ...)).
// `r.frete_vendedor_manual` (v86, escape hatch por pedido, mesmo padrão de
// tarifa_manual): quando não-NULL, `r.frete_vendedor` já vem da query com
// essa precedência aplicada (maior de todas) — aqui só decide se o indicador
// 🛵 (freteMotoboyAplicado) deve aparecer ou não, nunca recalcula por cima
// de uma edição manual.
function calcularMargemLinha(r, impostoFlexAtivo = false, freteMotoboy = null) {
  const fat = Number(r.faturamento) || 0;
  const custo = Number(r.custo) * (Number(r.quantity) || 1);
  const isFlex = r.frete_tipo === 'self_service';
  const imposto = (isFlex && !impostoFlexAtivo) ? 0 : fat * (Number(r.imposto_pct) / 100);
  const tarifa = Number(r.tarifa) || 0;
  const freteVendManual = r.frete_vendedor_manual != null;
  const freteMotoboyAplicado = !!(freteMotoboy?.ativo && isFlex && !freteVendManual);
  const freteVend = freteMotoboyAplicado
    ? Math.max(0, freteMotoboy.valor - (Number(r.frete_vendedor_reembolso) || 0))
    : Number(r.frete_vendedor) || 0;
  const freteComp = Number(r.frete_comprador) || 0;
  const margem = fat - custo - imposto - tarifa - freteComp - freteVend;
  const mc_pct = fat > 0 ? (margem / fat) * 100 : 0;
  return { ...r, custo, imposto, tarifa, freteVend, freteMotoboyAplicado, margem, mc_pct: Number(mc_pct.toFixed(2)) };
}

module.exports = { VENDA_DETALHE_SELECT, CONCILIACAO_TARIFA_LATERAL, calcularMargemLinha, buscarImpostoFlexAtivo, buscarFreteMotoboy };
