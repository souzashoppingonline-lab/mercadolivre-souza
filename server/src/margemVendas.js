// Margem de cada venda × o que o Mercado Pago paga — aba "Recebíveis Mercado Pago API"
// (Financeiro → Recebíveis). Ver .claude/modules.md (v159) e .claude/finance.md.
//
// NÃO é uma 2ª fórmula de margem: a margem vem SEMPRE de VENDA_DETALHE_SELECT +
// calcularMargemLinha (vendaMargem.js), que já usa o dado real do Mercado Pago
// quando existe (Conciliação → tarifa_real; senão ml_payments → bruto − líquido).
// Aqui só se junta, por pedido, o que a API diz que foi/vai ser pago
// (net_received_amount) e se marcam os casos pra conferir.
//
// "Memória" (margem_vendas_memoria, migrate-v132): 1 foto por pedido. Enquanto o
// dinheiro não foi liberado a foto é refeita a cada rodada; depois de liberado
// fica CONGELADA (custo/imposto da época) — mudar o custo do produto amanhã não
// reescreve o passado. EXCEÇÃO: venda gravada SEM custo cadastrado não congela —
// quando o custo é preenchido (modal "Cadastrar custo", mesma rota da página
// "Resumo por venda": PATCH /items/:id/custo) ela é refeita. Gravada pelo worker
// (05:35 + 2 min após o boot) e na hora, por anúncio, depois de salvar um custo.
const pool = require('./db/pool');
const { VENDA_DETALHE_SELECT, calcularMargemLinha, buscarImpostoFlexAtivo, buscarFreteMotoboy } = require('./vendaMargem');

// Mesmo limiar do alerta Telegram de divergência (checkConciliacaoDivergencias):
// o líquido ficou ≥ 50% abaixo do valor bruto do pagamento.
const DIFERENCA_ALERTA_PCT = 50;
const LOTE = 500;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Margem (fórmula única) de vários pedidos de uma vez: Map(order_id → linha calculada).
async function margemDosPedidos(orderIds) {
  const mapa = new Map();
  if (!orderIds.length) return mapa;
  const [impostoFlex, motoboy] = await Promise.all([buscarImpostoFlexAtivo(), buscarFreteMotoboy()]);
  for (let i = 0; i < orderIds.length; i += LOTE) {
    const { rows } = await pool.query(`${VENDA_DETALHE_SELECT} WHERE o.ml_id = ANY($1::text[])`, [orderIds.slice(i, i + LOTE)]);
    rows.forEach(r => mapa.set(String(r.ml_id), calcularMargemLinha(r, impostoFlex, motoboy)));
  }
  return mapa;
}

// Junta 1 pedido (pagamentos agregados) com a margem. `pg` = {order_id, store_id,
// nickname, recebido, bruto, liberacao, liberado}.
function montarVenda(pg, m) {
  const recebido = r2(pg.recebido), bruto = r2(pg.bruto);
  const alertas = [];
  if (!m) alertas.push('sem_pedido');
  else {
    if (m.custo_ausente) alertas.push('sem_custo');
    if (m.margem < 0) alertas.push('prejuizo');
  }
  if (bruto > 0 && (bruto - recebido) / bruto * 100 >= DIFERENCA_ALERTA_PCT) alertas.push('recebido_baixo');
  return {
    order_id: pg.order_id, store_id: pg.store_id, nickname: pg.nickname,
    item_id: m?.item_id || null, title: m?.title || null, sku: m?.sku || null, thumbnail: m?.thumbnail || null,
    buyer_nickname: m?.buyer_nickname || null, data_venda: m?.date_created || null,
    liberacao: pg.liberacao, liberado: !!pg.liberado,
    qtd: Number(m?.quantity) || 0,
    faturamento: m ? r2(m.faturamento) : null, bruto, recebido,
    custo: m ? r2(m.custo) : null, imposto: m ? r2(m.imposto) : null, tarifa: m ? r2(m.tarifa) : null,
    frete: m ? r2((Number(m.freteVend) || 0) + (Number(m.frete_comprador) || 0)) : null,
    margem: m ? r2(m.margem) : null, mc_pct: m ? Number(m.mc_pct) : null,
    custo_ausente: m ? !!m.custo_ausente : true, fonte_taxa: m?.fonte_taxa || null,
    alertas,
  };
}

// Pagamentos aprovados agrupados por pedido (um pedido pode ter mais de 1 pagamento).
const SQL_PAGAMENTOS_POR_PEDIDO = `
  SELECT p.order_id, p.store_id, s.nickname,
         SUM(p.net_received_amount) AS recebido, SUM(p.transaction_amount) AS bruto,
         MIN(p.money_release_date) AS liberacao,
         BOOL_AND(p.released = 'yes') AS liberado
    FROM ml_payments p LEFT JOIN stores s ON s.id = p.store_id
   WHERE p.status = 'approved' AND p.order_id IS NOT NULL`;

// Vendas que ainda vão cair (mesmo filtro da tabela/modal da aba): released≠'yes',
// loja opcional, dia de liberação (fuso SP) entre `de` e `ate`.
async function vendasAReceber({ storeId = '', de, ate }) {
  const { rows } = await pool.query(
    `${SQL_PAGAMENTOS_POR_PEDIDO}
       AND p.released IS DISTINCT FROM 'yes'
       AND ($1 = '' OR p.store_id = $1::bigint)
       AND (p.money_release_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
     GROUP BY p.order_id, p.store_id, s.nickname
     ORDER BY MIN(p.money_release_date)`,
    [String(storeId || ''), de, ate]);
  const mapa = await margemDosPedidos(rows.map(r => String(r.order_id)));
  return rows.map(r => montarVenda(r, mapa.get(String(r.order_id))));
}

// Grava/atualiza a memória. Pega pedido aprovado que (a) ainda não está na memória
// ou (b) está e ainda não foi liberado. Liberado = congela (o WHERE do upsert
// impede reescrever). `retroativo` = a 1ª foto já foi tirada depois da liberação
// (pedidos antigos, gravados no 1º run com o custo de HOJE, não o da época).
// `itemId` (opcional): só os pedidos desse anúncio, ignorando a trava de 30 min —
// usado logo depois de salvar o custo, pra tela já mostrar a margem certa.
async function gravarMemoria({ itemId = null, log = console.log } = {}) {
  let gravados = 0, lotes = 0;
  const vistos = new Set();
  for (;;) {
    const { rows } = await pool.query(
      `${SQL_PAGAMENTOS_POR_PEDIDO}
         AND NOT EXISTS (SELECT 1 FROM margem_vendas_memoria mm WHERE mm.order_id = p.order_id AND mm.liberado AND NOT mm.custo_ausente)
         AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.ml_id = p.order_id AND o.item_id = $1))
         AND NOT (p.order_id = ANY($2::text[]))
       GROUP BY p.order_id, p.store_id, s.nickname
       HAVING $1::text IS NOT NULL OR NOT EXISTS (SELECT 1 FROM margem_vendas_memoria mm WHERE mm.order_id = p.order_id
                            AND mm.atualizado_em > now() - interval '30 minutes')
       ORDER BY MIN(p.money_release_date) NULLS LAST
       LIMIT ${LOTE}`, [itemId, itemId ? [...vistos] : []]);   // `vistos` só no modo por anúncio (sem a trava de 30 min)
    if (!rows.length) break;
    const mapa = await margemDosPedidos(rows.map(r => String(r.order_id)));
    const vendas = rows.map(r => montarVenda(r, mapa.get(String(r.order_id))));
    rows.forEach(r => vistos.add(String(r.order_id)));
    await pool.query(
      `INSERT INTO margem_vendas_memoria (order_id, store_id, item_id, title, sku, data_venda, data_liberacao, liberado,
          qtd, faturamento, bruto, recebido, custo, imposto, tarifa, frete, margem, mc_pct, custo_ausente, fonte_taxa,
          alertas, retroativo, gravado_em, atualizado_em)
       SELECT x.order_id, x.store_id, x.item_id, x.title, x.sku, x.data_venda, x.liberacao, x.liberado,
              x.qtd, x.faturamento, x.bruto, x.recebido, x.custo, x.imposto, x.tarifa, x.frete, x.margem, x.mc_pct,
              x.custo_ausente, x.fonte_taxa, x.alertas,
              (x.liberado AND x.liberacao < now() - interval '2 days'), now(), now()
         FROM jsonb_to_recordset($1::jsonb) AS x(order_id text, store_id bigint, item_id text, title text, sku text,
              data_venda timestamptz, liberacao timestamptz, liberado boolean, qtd int, faturamento numeric, bruto numeric,
              recebido numeric, custo numeric, imposto numeric, tarifa numeric, frete numeric, margem numeric,
              mc_pct numeric, custo_ausente boolean, fonte_taxa text, alertas text[])
       ON CONFLICT (order_id) DO UPDATE SET
          store_id = EXCLUDED.store_id, item_id = EXCLUDED.item_id, title = EXCLUDED.title, sku = EXCLUDED.sku,
          data_venda = EXCLUDED.data_venda, data_liberacao = EXCLUDED.data_liberacao, liberado = EXCLUDED.liberado,
          qtd = EXCLUDED.qtd, faturamento = EXCLUDED.faturamento, bruto = EXCLUDED.bruto, recebido = EXCLUDED.recebido,
          custo = EXCLUDED.custo, imposto = EXCLUDED.imposto, tarifa = EXCLUDED.tarifa, frete = EXCLUDED.frete,
          margem = EXCLUDED.margem, mc_pct = EXCLUDED.mc_pct, custo_ausente = EXCLUDED.custo_ausente,
          fonte_taxa = EXCLUDED.fonte_taxa, alertas = EXCLUDED.alertas, atualizado_em = now()
        WHERE NOT margem_vendas_memoria.liberado OR margem_vendas_memoria.custo_ausente`,
      [JSON.stringify(vendas)]);
    gravados += vendas.length; lotes++;
    if (rows.length < LOTE || lotes >= 200) break;   // trava de segurança (100 mil pedidos por rodada)
  }
  // v178 (bug: "coloco o custo e clico salvar, não salva") — no modo por anúncio,
  // regrava também as vendas do anúncio que JÁ estão na memória sem custo mas
  // que a consulta acima não pega mais porque o pagamento deixou de ser
  // 'approved' (reembolsado/cancelado depois). Sem isso o anúncio continuava em
  // "Precisa do seu custo" mesmo com o custo salvo. Só recalcula custo/margem
  // (recebido/bruto/liberação ficam como estão na memória).
  let restantes = 0;
  if (itemId) {
    const { rows: rest } = await pool.query(
      `SELECT order_id, store_id, recebido, bruto, data_liberacao AS liberacao, liberado
         FROM margem_vendas_memoria WHERE item_id = $1 AND custo_ausente AND NOT (order_id = ANY($2::text[]))`,
      [itemId, [...vistos]]);
    if (rest.length) {
      const mapa = await margemDosPedidos(rest.map(r => String(r.order_id)));
      const vendas = rest.map(r => ({ r, m: mapa.get(String(r.order_id)) })).filter(x => x.m).map(({ r, m }) => montarVenda(r, m));
      if (vendas.length) {
        await pool.query(
          `UPDATE margem_vendas_memoria mm SET custo = x.custo, imposto = x.imposto, tarifa = x.tarifa, frete = x.frete,
                  margem = x.margem, mc_pct = x.mc_pct, custo_ausente = x.custo_ausente, alertas = x.alertas, atualizado_em = now()
             FROM jsonb_to_recordset($1::jsonb) AS x(order_id text, custo numeric, imposto numeric, tarifa numeric, frete numeric,
                  margem numeric, mc_pct numeric, custo_ausente boolean, alertas text[])
            WHERE mm.order_id = x.order_id AND mm.custo_ausente`,
          [JSON.stringify(vendas)]);
        restantes = vendas.length;
      }
    }
  }
  log(`[margem-memoria]${itemId ? ` item ${itemId}:` : ''} ${gravados} pedido(s) gravado(s)/atualizado(s) em ${lotes} lote(s)${restantes ? ` + ${restantes} sem pagamento aprovado` : ''}`);
  return { gravados, lotes, restantes };
}

// "Onde ganho e onde perco": agrega a memória por anúncio no período (data da venda).
async function ranking({ dias = 30, storeId = '', top = 15 } = {}) {
  const params = [Math.min(Math.max(Number(dias) || 30, 1), 365), String(storeId || '')];
  const filtro = `m.data_venda >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1)
                  AND ($2 = '' OR m.store_id = $2::bigint) AND m.margem IS NOT NULL`;
  const [{ rows: itens }, { rows: lojas }, { rows: [tot] }] = await Promise.all([
    pool.query(
      `SELECT m.item_id, MAX(m.title) AS title, MAX(s.nickname) AS nickname, COUNT(*) AS vendas, SUM(m.qtd) AS qtd,
              SUM(m.faturamento) AS faturamento, SUM(m.recebido) AS recebido, SUM(m.custo) AS custo,
              SUM(m.imposto) AS imposto, SUM(m.margem) AS margem,
              COUNT(*) FILTER (WHERE m.custo_ausente) AS sem_custo, COUNT(*) FILTER (WHERE m.margem < 0) AS vendas_prejuizo
         FROM margem_vendas_memoria m LEFT JOIN stores s ON s.id = m.store_id
        WHERE ${filtro} GROUP BY m.item_id`, params),
    pool.query(
      `SELECT m.store_id, MAX(s.nickname) AS nickname, COUNT(*) AS vendas, SUM(m.faturamento) AS faturamento,
              SUM(m.recebido) AS recebido, SUM(m.margem) AS margem
         FROM margem_vendas_memoria m LEFT JOIN stores s ON s.id = m.store_id
        WHERE ${filtro} GROUP BY m.store_id ORDER BY SUM(m.margem) DESC`, params),
    pool.query(
      `SELECT COUNT(*) AS vendas, COALESCE(SUM(m.faturamento),0) AS faturamento, COALESCE(SUM(m.recebido),0) AS recebido,
              COALESCE(SUM(m.margem),0) AS margem, COUNT(*) FILTER (WHERE m.custo_ausente) AS sem_custo,
              MIN(m.gravado_em) AS desde, MAX(m.atualizado_em) AS atualizado
         FROM margem_vendas_memoria m WHERE ${filtro}`, params),
  ]);
  const pct = (a, b) => (Number(b) > 0 ? Number((Number(a) / Number(b) * 100).toFixed(1)) : 0);
  const norm = r => ({
    item_id: r.item_id, title: r.title, nickname: r.nickname, vendas: Number(r.vendas), qtd: Number(r.qtd) || 0,
    faturamento: r2(r.faturamento), recebido: r2(r.recebido), custo: r2(r.custo), imposto: r2(r.imposto),
    margem: r2(r.margem), mc_pct: pct(r.margem, r.faturamento),
    sem_custo: Number(r.sem_custo), vendas_prejuizo: Number(r.vendas_prejuizo),
  });
  const todos = itens.map(norm);
  // Anúncio cujo custo não está cadastrado em nenhuma venda tem "margem" inflada
  // (custo = 0) — fica fora do ranking de ganho e aparece na lista própria.
  const confiaveis = todos.filter(i => i.sem_custo < i.vendas);
  return {
    dias: params[0],
    totais: { vendas: Number(tot.vendas), faturamento: r2(tot.faturamento), recebido: r2(tot.recebido),
      margem: r2(tot.margem), mc_pct: pct(tot.margem, tot.faturamento), sem_custo: Number(tot.sem_custo),
      anuncios: todos.length, desde: tot.desde, atualizado: tot.atualizado },
    por_empresa: lojas.map(l => ({ store_id: l.store_id, nickname: l.nickname, vendas: Number(l.vendas),
      faturamento: r2(l.faturamento), recebido: r2(l.recebido), margem: r2(l.margem), mc_pct: pct(l.margem, l.faturamento) })),
    ganhos: confiaveis.filter(i => i.margem > 0).sort((a, b) => b.margem - a.margem).slice(0, top),
    perdas: confiaveis.filter(i => i.margem < 0).sort((a, b) => a.margem - b.margem).slice(0, top),
    margem_baixa: confiaveis.filter(i => i.margem >= 0 && i.mc_pct < 5 && i.faturamento > 0)
      .sort((a, b) => b.faturamento - a.faturamento).slice(0, top),
    sem_custo: todos.filter(i => i.sem_custo > 0).sort((a, b) => b.faturamento - a.faturamento).slice(0, top),
  };
}

module.exports = { DIFERENCA_ALERTA_PCT, margemDosPedidos, montarVenda, vendasAReceber, gravarMemoria, ranking };
