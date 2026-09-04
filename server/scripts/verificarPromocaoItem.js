// Verificação AO VIVO, direto na API OFICIAL do Mercado Livre (nunca um
// conector de terceiro) — confirma se um anúncio tem promoção ativa AGORA,
// e compara com o que o webhook public_offers já tinha gravado na tabela
// `promotions` (fonte que o Analista Ecom/bi-vendas leem). Ver
// .claude/decisions.md e .claude/mercadolivre.md.
//
// Uso (rodar NO SERVIDOR, onde os tokens OAuth reais estão salvos):
//   node server/scripts/verificarPromocaoItem.js <ml_id> [store_id]
//
// store_id é opcional se o item já estiver sincronizado em `items` — o
// script descobre a loja sozinho nesse caso.
const pool = require('../src/db/pool');
const ml = require('../src/mlClient');

async function main() {
  const [mlId, storeIdArg] = process.argv.slice(2);
  if (!mlId) {
    console.error('Uso: node server/scripts/verificarPromocaoItem.js <ml_id> [store_id]');
    process.exit(1);
  }

  let storeId = storeIdArg;
  if (!storeId) {
    const { rows } = await pool.query(`SELECT store_id FROM items WHERE ml_id=$1`, [mlId]);
    if (!rows.length) {
      console.error(`Item ${mlId} não encontrado em items — informe store_id manualmente.`);
      process.exit(1);
    }
    storeId = rows[0].store_id;
  }

  console.log(`Consultando a API OFICIAL do Mercado Livre pra ${mlId} (loja ${storeId})...\n`);

  let promocoesAoVivo;
  try {
    promocoesAoVivo = await ml.getItemPromotions(mlId, storeId);
  } catch (e) {
    console.error(`Erro consultando a API oficial: ${e.message}`);
    process.exit(1);
  }

  const lista = Array.isArray(promocoesAoVivo) ? promocoesAoVivo : (promocoesAoVivo?.results || []);
  console.log(`=== API OFICIAL (GET /seller-promotions/items/${mlId}) ===`);
  if (!lista.length) {
    console.log('Nenhuma promoção retornada pela API pra este item agora.');
  } else {
    for (const p of lista) {
      console.log(`- tipo=${p.type || p.promotion_type || '?'} status=${p.status} id=${p.id || p.promotion_id || '?'} preço_promo=${p.price ?? p.offer_price ?? '?'}`);
    }
  }

  const { rows: gravado } = await pool.query(
    `SELECT status, promo_price, discount_pct, changed_at FROM promotions WHERE item_id=$1 ORDER BY changed_at DESC LIMIT 1`,
    [mlId]
  );
  console.log(`\n=== ÚLTIMO REGISTRO NO BANCO (tabela promotions, via webhook public_offers) ===`);
  if (!gravado.length) {
    console.log('Nenhum registro — este item nunca recebeu um webhook de promoção.');
  } else {
    const g = gravado[0];
    console.log(`- status=${g.status} preço_promo=${g.promo_price ?? '—'} desconto=${g.discount_pct ?? '—'}% gravado_em=${g.changed_at.toISOString()}`);
  }

  const temAtivaAoVivo = lista.some(p => p.status === 'active' || p.status === 'started');
  const temAtivaBanco = gravado[0]?.status === 'active';
  console.log(`\n=== CONCLUSÃO ===`);
  console.log(`API oficial agora:     ${temAtivaAoVivo ? 'TEM promoção ativa' : 'sem promoção ativa'}`);
  console.log(`Banco (Analista Ecom): ${temAtivaBanco ? 'TEM promoção ativa' : 'sem promoção ativa'}`);
  console.log(temAtivaAoVivo === temAtivaBanco ? '✅ Batem — o dashboard está refletindo o estado real do Mercado Livre.' : '⚠️ Divergem — o webhook pode ainda não ter processado a mudança mais recente (aguarde alguns segundos e rode de novo).');

  await pool.end();
}

main().catch((e) => { console.error('Falha:', e.message); process.exit(1); });
