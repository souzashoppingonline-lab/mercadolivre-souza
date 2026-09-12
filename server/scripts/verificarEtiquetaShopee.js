// Diagnóstico: por que uma etiqueta Shopee bipada na Embalagem deu "Nenhum
// pedido encontrado" — reproduz os MESMOS passos de GET /api/embalagem/
// pedido/:shippingId (routes/embalagem.js) fora da rota, com log de cada
// etapa, pra achar a causa real em vez de chutar. Ver .claude/embalagem.md.
//
// Uso (rodar NO SERVIDOR, onde os tokens Shopee reais estão salvos):
//   node server/scripts/verificarEtiquetaShopee.js <codigo bipado, ex. BR264185314030M> [order_sn, ex. 260908F3RFQEFD]
//
// order_sn é opcional — vem impresso na própria etiqueta em "Pedido:". Quando
// informado, o script busca esse pedido DIRETO (passo 7), sem depender do
// tracking_number — confirma se o pedido já existe no banco (sincronizado)
// mesmo que o tracking ainda não tenha chegado.
const pool = require('../src/db/pool');
const env = require('../src/config/env');
const { getShopeeClientForStore } = require('../src/marketplaces/shopee/shopeeClient');

async function main() {
  const codigo = String(process.argv[2] || '').trim();
  const orderSn = String(process.argv[3] || '').trim();
  if (!codigo) {
    console.error('Uso: node server/scripts/verificarEtiquetaShopee.js <codigo bipado> [order_sn]');
    process.exit(1);
  }

  console.log(`Diagnosticando etiqueta "${codigo}"...\n`);

  // 1. Match exato (o que a rota faz primeiro)
  const exato = await pool.query(
    `SELECT sod.order_sn, sod.tracking_number, o.store_id, o.status, o.date_created, s.nickname
       FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
       LEFT JOIN stores s ON s.id = o.store_id
      WHERE sod.tracking_number = $1`,
    [codigo]
  );
  console.log(`1. Match exato em shopee_order_data.tracking_number: ${exato.rows.length} resultado(s)`);
  exato.rows.forEach(r => console.log(`   order_sn=${r.order_sn} loja=${r.nickname} status=${r.status} tracking="${r.tracking_number}"`));

  // 2. Match "parecido" (case/espaço/prefixo) — descarta erro de digitação/scanner.
  const parecido = await pool.query(
    `SELECT sod.order_sn, sod.tracking_number, o.date_created
       FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.tracking_number IS NOT NULL
        AND (UPPER(TRIM(sod.tracking_number)) = UPPER($1) OR sod.tracking_number ILIKE $2)
      LIMIT 10`,
    [codigo, `%${codigo.replace(/[%_]/g, '')}%`]
  );
  console.log(`\n2. Match parecido (case/espaço/substring): ${parecido.rows.length} resultado(s)`);
  parecido.rows.forEach(r => console.log(`   order_sn=${r.order_sn} tracking="${r.tracking_number}" (bipado: "${codigo}")`));

  // 3. Quantos pedidos Shopee dos últimos 20 dias ainda estão SEM tracking —
  // é a mesma janela que refreshShopeeTrackingOnDemand() usa (LIMIT 40). Se
  // esse número passar de 40, pedidos mais antigos dentro da janela nunca são
  // tentados no bipe (a rota corta em 40 pra não estourar rate limit/latência).
  const semTracking = await pool.query(
    `SELECT COUNT(*) AS n FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.tracking_number IS NULL AND o.date_created > now() - interval '20 days'`
  );
  const n = Number(semTracking.rows[0].n);
  console.log(`\n3. Pedidos Shopee (últimos 20 dias) ainda SEM tracking_number no banco: ${n}`);
  if (n > 40) console.log(`   ⚠️ Passa de 40 — a busca sob demanda (LIMIT 40, mais recentes primeiro) pode não alcançar pedidos mais antigos dentro da janela. Candidato real ao bug.`);

  // 4. O pedido bipado está entre os "sem tracking" recentes? Se sim, tenta
  // buscar o tracking dele AO VIVO na API oficial da Shopee (mesmo client que
  // a rota usa) — reproduz exatamente o passo que falhou na hora do bipe.
  const candidatos = await pool.query(
    `SELECT sod.order_sn, o.store_id, o.date_created, o.status, s.nickname
       FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
       LEFT JOIN stores s ON s.id = o.store_id
      WHERE sod.tracking_number IS NULL AND o.date_created > now() - interval '20 days'
      ORDER BY o.date_created DESC LIMIT 40`
  );
  console.log(`\n4. Testando os ${candidatos.rows.length} candidatos (mesmo universo que a rota tenta) contra a API oficial da Shopee...`);
  const clients = new Map();
  let achou = false;
  for (const r of candidatos.rows) {
    if (!clients.has(r.store_id)) {
      try { clients.set(r.store_id, await getShopeeClientForStore(pool, r.store_id, env.shopee)); }
      catch (e) { console.log(`   [loja ${r.nickname || r.store_id}] falha ao montar client: ${e.message}`); clients.set(r.store_id, null); }
    }
    const client = clients.get(r.store_id);
    if (!client) continue;
    try {
      const tn = await client.getTrackingNumber(r.order_sn);
      const bate = tn === codigo;
      if (bate) achou = true;
      console.log(`   order_sn=${r.order_sn} loja=${r.nickname} status=${r.status} data=${r.date_created ? r.date_created.toISOString().slice(0,10) : '?'} → tracking ao vivo: "${tn || '(vazio)'}"${bate ? '  ✅ BATE COM O BIPADO' : ''}`);
      if (bate) break;
    } catch (e) {
      console.log(`   order_sn=${r.order_sn} loja=${r.nickname} status=${r.status} → erro na API: ${e.message}`);
    }
  }
  console.log(`\nResultado: ${achou ? '✅ achado ao vivo — provavelmente um problema de timing (worker ainda não tinha sincronizado no momento do bipe, mas agora resolveria).' : '❌ não achado nos 40 candidatos recentes.'}`);
  if (!achou) {
    console.log('Possíveis causas, na ordem mais provável:');
    console.log('  a) Pedido tem mais de 20 dias (fora da janela de busca sob demanda) — confirmar a data do pedido.');
    console.log('  b) Pedido ainda não chegou no status "embarcável" (SHOPEE_SHIPPABLE) — a Logistics API não tem rastreio antes disso (ver .claude/shopee.md).');
    console.log('  c) O código bipado tem erro de leitura do scanner (comparar com o item 2 acima).');
    console.log('  d) O pedido nem existe ainda em orders/shopee_order_data — sincronização atrasada ou pedido de loja não cadastrada.');
  }

  // 5. Total real de pedidos Shopee sem tracking, SEM corte de data — mostra se
  // existe volume relevante fora da janela de 20 dias usada nos passos 3/4.
  const semTrackingTotal = await pool.query(
    `SELECT COUNT(*) AS n FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.tracking_number IS NULL`
  );
  console.log(`\n5. Total de pedidos Shopee sem tracking_number no banco (sem corte de data): ${semTrackingTotal.rows[0].n}`);

  // 6. Os 10 pedidos sem tracking mais ANTIGOS — se o pedido da etiqueta bipada
  // estiver aqui (ou for mais antigo ainda), confirma a causa (a): fora da janela.
  const maisAntigos = await pool.query(
    `SELECT sod.order_sn, o.status, o.date_created, s.nickname
       FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
       LEFT JOIN stores s ON s.id = o.store_id
      WHERE sod.tracking_number IS NULL
      ORDER BY o.date_created ASC LIMIT 10`
  );
  console.log(`\n6. Os ${maisAntigos.rows.length} pedidos sem tracking mais antigos no banco:`);
  maisAntigos.rows.forEach(r => console.log(`   order_sn=${r.order_sn} loja=${r.nickname} status=${r.status} data=${r.date_created ? r.date_created.toISOString().slice(0,10) : '?'}`));

  // 7. Busca direta pelo order_sn impresso na etiqueta (campo "Pedido:") — não
  // depende do tracking_number estar preenchido. Se não achar nada aqui, o
  // pedido ainda nem chegou no banco (worker/webhook não sincronizou ainda).
  if (orderSn) {
    const direto = await pool.query(
      `SELECT sod.order_sn, sod.tracking_number, o.store_id, o.status, o.date_created, s.nickname
         FROM shopee_order_data sod JOIN orders o ON o.ml_id = sod.order_sn
         LEFT JOIN stores s ON s.id = o.store_id
        WHERE sod.order_sn = $1`,
      [orderSn]
    );
    console.log(`\n7. Busca direta por order_sn="${orderSn}" (sem depender do tracking): ${direto.rows.length} resultado(s)`);
    if (direto.rows.length) {
      direto.rows.forEach(r => console.log(`   loja=${r.nickname} status=${r.status} data=${r.date_created ? r.date_created.toISOString().slice(0,10) : '?'} tracking="${r.tracking_number || '(vazio)'}"`));
    } else {
      console.log('   ❌ Pedido não existe no banco ainda — worker/webhook não sincronizou esse pedido. Causa (d) confirmada.');
    }
  }

  // 8. Busca DIRETA na API oficial, sem depender de banco local nem de lista/
  // janela de tempo (listRecentOrders pode não trazer o pedido se o
  // update_time dele já estiver fora da janela testada) — chama getOrder
  // direto pra cada loja Shopee cadastrada. É o teste mais definitivo:
  // se a Shopee não devolve nada aqui, o pedido genuinamente não está
  // disponível via API ainda (problema do lado da Shopee, não nosso).
  if (orderSn) {
    console.log(`\n8. Busca DIRETA na API (getOrder, sem lista/janela) por order_sn="${orderSn}" em cada loja Shopee:`);
    const { rows: lojas } = await pool.query(
      `SELECT id, nickname FROM stores WHERE marketplace_id = (SELECT id FROM marketplaces WHERE code = 'SHOPEE')`
    );
    for (const loja of lojas) {
      let client;
      try { client = await getShopeeClientForStore(pool, loja.id, env.shopee); }
      catch (e) { console.log(`   [loja ${loja.nickname}] falha ao montar client: ${e.message}`); continue; }
      try {
        const o = await client.getOrder(orderSn);
        if (o?.order_sn) {
          console.log(`   [loja ${loja.nickname}] ✅ encontrado ao vivo: status=${o.order_status} total=${o.total_amount}`);
        } else {
          console.log(`   [loja ${loja.nickname}] resposta vazia (pedido não pertence a essa loja, ou API não devolveu nada)`);
        }
      } catch (e) {
        console.log(`   [loja ${loja.nickname}] erro na API: ${e.message}`);
      }
    }
  }

  await pool.end();
}

main().catch(e => { console.error('Erro:', e.message); process.exit(1); });
