// IA Estrategista na rotina (v123) — lógica dos jobs do worker (agendados em
// worker.js: diário 08:05 e críticos a cada 2h). Separado do worker pra poder
// ser testado contra um Postgres de verdade (test manual) sem subir BullMQ.
// Textos em iaEstrategistaAvisos.js. `tg` = tgNotify (tópico tg_ia_estrategista).
const pool = require('./db/pool');
const dados = require('./iaEstrategistaDados');
const av = require('./iaEstrategistaAvisos');
const { estaEmSilencio } = require('./notify');
const pausa = ms => new Promise(res => setTimeout(res, ms));

async function iaEstrSalvarEstado(anuncios) {
  if (!anuncios.length) return;
  await pool.query(
    `INSERT INTO ia_estrategista_estado (ranking_ad_id, prioridade, atualizado_em)
     SELECT * , now() FROM unnest($1::int[], $2::int[])
     ON CONFLICT (ranking_ad_id) DO UPDATE SET prioridade = EXCLUDED.prioridade, atualizado_em = now()`,
    [anuncios.map(x => x.ranking_ad_id), anuncios.map(x => x.prioridade.nota)]);
}
async function iaEstrNovosCriticos(anuncios) {
  const { rows } = await pool.query(`SELECT ranking_ad_id, prioridade FROM ia_estrategista_estado`);
  if (!rows.length) return { primeiraVez: true, lista: [] };
  const antes = new Map(rows.map(r => [r.ranking_ad_id, r.prioridade]));
  return { primeiraVez: false, lista: anuncios.filter(x => x.prioridade.nota >= 80 && !(antes.get(x.ranking_ad_id) >= 80))
    .map(x => ({ x, antes: antes.has(x.ranking_ad_id) ? antes.get(x.ranking_ad_id) : null })) };
}
async function runIaEstrategistaDiario({ tg, dashUrl, espera = 1200 }) {
  const r = await dados.carteira({ periodo: 14, storeId: '', semCache: true });
  if (r.anuncios.length) {
    const { lista: novosCriticos } = await iaEstrNovosCriticos(r.anuncios);
    await tg(av.textoPrioridades(r, { novosCriticos, dashUrl }));
    await iaEstrSalvarEstado(r.anuncios);
  }
  // Ações paradas (pendente/em execução há 7+ dias no mesmo status).
  const { rows: paradas } = await pool.query(
    `SELECT * FROM ia_estrategista_acoes WHERE status IN ('pendente','em_execucao') AND status_desde < now() - interval '7 days'
      ORDER BY status_desde LIMIT 15`);
  if (paradas.length) { await pausa(espera); await tg(av.textoParadas(paradas, { dashUrl })); }
  // Resultado automático 14 dias depois de concluída (1 vez por conclusão).
  const { rows: concl } = await pool.query(
    `SELECT * FROM ia_estrategista_acoes WHERE status = 'concluida' AND executada_em <= now() - interval '14 days' AND resultado_auto_em IS NULL
      ORDER BY executada_em LIMIT 20`);
  let resultados = 0;
  for (const a of await dados.comAntesDepois(concl)) {
    const resumo = av.resumoResultado(a);
    if (!resumo) continue;
    await pool.query(
      `UPDATE ia_estrategista_acoes SET resultado_auto_em = now(), updated_at = now(),
         resultado_observado = CASE WHEN COALESCE(resultado_observado, '') = '' THEN $2 ELSE resultado_observado || E'\n' || $2 END
       WHERE id = $1`, [a.id, resumo]);
    await pausa(espera);
    await tg(av.textoResultado(a, { dashUrl }));
    resultados++;
  }
  console.log(`[ia-estrategista] diário: ${r.anuncios.length} anúncio(s), ${paradas.length} ação(ões) parada(s), ${resultados} resultado(s) automático(s)`);
  return { anuncios: r.anuncios.length, paradas: paradas.length, resultados };
}
async function runIaEstrategistaCriticos({ tg, dashUrl, ignorarHorario = false }) {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  if (!ignorarHorario && (h < 10 || h > 20)) return null; // 08h já sai no relatório do dia
  if (await estaEmSilencio()) return null;
  const r = await dados.carteira({ periodo: 14, storeId: '' });
  const { primeiraVez, lista } = await iaEstrNovosCriticos(r.anuncios);
  if (!primeiraVez && lista.length) await tg(av.textoCriticos(lista, { dashUrl }));
  await iaEstrSalvarEstado(r.anuncios);
  return lista.length;
}

module.exports = { runIaEstrategistaDiario, runIaEstrategistaCriticos };
