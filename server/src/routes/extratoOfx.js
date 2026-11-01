// Extrato Bancário (OFX) — Financeiro. Montado em /api/financeiro/extrato-ofx
// (mesmo gate admin-only do módulo Financeiro, staffAuth MODULES). Dados no
// Postgres do servidor (migrate-v127). Leitura do arquivo em ofx.js, categorias
// em ofxCategorias.js, números em ofxAnalise.js; a IA só interpreta o resumo.
// Ver .claude/extrato-ofx.md.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db/pool');
const { lerOfx } = require('../ofx');
const { CATEGORIAS, POR_ID, classificar, norm } = require('../ofxCategorias');
const { resumoMes } = require('../ofxAnalise');
const llm = require('../ai/llm');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 12 } });
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const fimDoMes = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const somaMeses = (mes, n) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const quem = (req) => (req.staffUser && req.staffUser.username) || null;

async function carregarRegras(db = pool) {
  const { rows } = await db.query('SELECT contraparte_chave, categoria, apelido FROM ofx_regras');
  return new Map(rows.map((r) => [r.contraparte_chave, r]));
}

// Grava uma conta do OFX numa transação; devolve { conta_id, lidos, novos }.
async function importarConta(c, bancoNome, arquivoNome, regras, usuario) {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const { rows: [conta] } = await cx.query(
      `INSERT INTO ofx_contas (banco_id, banco_nome, agencia, conta, tipo_conta) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (banco_id, agencia, conta) DO UPDATE SET banco_nome = COALESCE(EXCLUDED.banco_nome, ofx_contas.banco_nome)
       RETURNING id`, [c.banco_id || '', bancoNome || null, c.agencia || '', c.conta || 'sem-numero', c.tipo_conta]);
    const { rows: [imp] } = await cx.query(
      `INSERT INTO ofx_importacoes (conta_id, arquivo_nome, dt_inicio, dt_fim, saldo_final, saldo_final_em, lidos, importado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [conta.id, arquivoNome, c.dt_inicio, c.dt_fim, c.saldo_final, c.saldo_final_em, c.lancamentos.length, usuario]);
    // Chave anti-duplicado: data|valor|descrição|nº da ocorrência (o FITID muda a cada exportação em alguns bancos).
    const ocorr = {};
    const cols = { chave: [], fitid: [], data: [], valor: [], tipo: [], descricao: [], contraparte: [], cpk: [], categoria: [], origem: [] };
    for (const l of c.lancamentos) {
      const descricao = [l.nome, l.memo].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ') || l.tipo || '—';
      const base = `${l.data}|${l.valor.toFixed(2)}|${norm(descricao)}`;
      ocorr[base] = (ocorr[base] || 0) + 1;
      const cl = classificar(descricao, l.valor, regras);
      cols.chave.push(crypto.createHash('sha1').update(`${base}|${ocorr[base]}`).digest('hex'));
      cols.fitid.push(l.fitid); cols.data.push(l.data); cols.valor.push(l.valor); cols.tipo.push(l.tipo);
      cols.descricao.push(descricao.slice(0, 300)); cols.contraparte.push(cl.contraparte); cols.cpk.push(cl.contraparte_chave);
      cols.categoria.push(cl.categoria); cols.origem.push(cl.origem);
    }
    const { rowCount: novos } = await cx.query(
      `INSERT INTO ofx_lancamentos (conta_id, chave, fitid, data, valor, tipo, descricao, contraparte, contraparte_chave, categoria, categoria_origem, importacao_id)
       SELECT $1::int, u.*, $12::int FROM unnest($2::text[], $3::text[], $4::date[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS u
       ON CONFLICT (conta_id, chave) DO NOTHING`,
      [conta.id, cols.chave, cols.fitid, cols.data, cols.valor, cols.tipo, cols.descricao, cols.contraparte, cols.cpk, cols.categoria, cols.origem, imp.id]);
    await cx.query('UPDATE ofx_importacoes SET novos = $2 WHERE id = $1', [imp.id, novos]);
    await cx.query('COMMIT');
    return { conta_id: conta.id, lidos: c.lancamentos.length, novos, dt_inicio: c.dt_inicio, dt_fim: c.dt_fim };
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cx.release(); }
}

// POST /importar (multipart, campo "arquivos") → { arquivos:[{nome, ok, erro?, banco, contas:[{conta_id, lidos, novos, dt_inicio, dt_fim}]}] }
router.post('/importar', upload.array('arquivos', 12), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Envie pelo menos um arquivo OFX.' });
  try {
    const regras = await carregarRegras();
    const out = [];
    for (const f of files) {
      try {
        const ofx = lerOfx(f.buffer);
        const contas = [];
        for (const c of ofx.contas) contas.push(await importarConta(c, ofx.banco_nome, f.originalname, regras, quem(req)));
        out.push({ nome: f.originalname, ok: true, banco: ofx.banco_nome, contas });
      } catch (e) {
        console.warn('[extrato-ofx] importar', f.originalname, e.message);
        out.push({ nome: f.originalname, ok: false, erro: e.message });
      }
    }
    if (out.some((a) => a.ok)) {
      try { await salvarResumosMensais(); } catch (e) { console.error('[extrato-ofx] resumo mensal', e.message); }
    }
    res.json({ arquivos: out });
  } catch (e) {
    console.error('[extrato-ofx] importar', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /contas → contas, cobertura e meses com lançamentos (pros filtros).
router.get('/contas', async (req, res) => {
  try {
    const [{ rows: contas }, { rows: meses }] = await Promise.all([
      pool.query(`SELECT c.id, c.banco_id, c.banco_nome, c.agencia, c.conta, c.tipo_conta, c.apelido,
                         MIN(l.data) AS desde, MAX(l.data) AS ate, COUNT(l.id)::int AS lancamentos,
                         (SELECT MAX(i.importado_em) FROM ofx_importacoes i WHERE i.conta_id = c.id) AS ultima_importacao
                    FROM ofx_contas c LEFT JOIN ofx_lancamentos l ON l.conta_id = c.id
                   GROUP BY c.id ORDER BY c.id`),
      pool.query(`SELECT to_char(data, 'YYYY-MM') AS mes, COUNT(*)::int AS lancamentos FROM ofx_lancamentos GROUP BY 1 ORDER BY 1 DESC`),
    ]);
    // Número da conta mascarado na tela (••1234).
    res.json({ contas: contas.map((c) => ({ ...c, conta_mask: '••' + String(c.conta).slice(-4) })), meses, categorias: CATEGORIAS });
  } catch (e) { console.error('[extrato-ofx] contas', e.message); res.status(500).json({ error: e.message }); }
});

// Saldo no fim do mês de UMA conta, a partir do saldo do OFX mais recente.
// Data do saldo = fim do período do arquivo (dt_fim): o Santander põe em
// <DTASOF> a hora da exportação, mas o <BALAMT> é o saldo do fim do período
// (conferido com o "Caixa Dia 1" de out/2026). Ver extrato-ofx.md.
async function saldoFimDoMes(contaId, fim) {
  const { rows: [ref] } = await pool.query(
    `SELECT saldo_final, COALESCE(dt_fim, saldo_final_em) AS em FROM ofx_importacoes
      WHERE conta_id = $1 AND saldo_final IS NOT NULL ORDER BY COALESCE(dt_fim, saldo_final_em) DESC, id DESC LIMIT 1`, [contaId]);
  if (!ref || !ref.em) return null;
  const em = new Date(ref.em).toISOString().slice(0, 10);
  if (em < fim) return { valor: Number(ref.saldo_final), data: em, parcial: true };
  const { rows: [s] } = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float AS soma FROM ofx_lancamentos WHERE conta_id = $1 AND data > $2 AND data <= $3`, [contaId, fim, em]);
  return { valor: Number(ref.saldo_final) - s.soma, data: fim, parcial: false };
}

async function montarResumo(mes, contaId) {
  const fim = fimDoMes(mes), ini3 = `${somaMeses(mes, -3)}-01`;
  const filtroConta = contaId ? 'AND conta_id = $3' : '';
  const params = (a, b) => (contaId ? [a, b, contaId] : [a, b]);
  const sel = `SELECT id, conta_id, data, valor::float AS valor, categoria, categoria_origem, contraparte, contraparte_chave, descricao FROM ofx_lancamentos`;
  const [{ rows: lancs }, { rows: anteriores }] = await Promise.all([
    pool.query(`${sel} WHERE data >= $1 AND data <= $2 ${filtroConta} ORDER BY data, id`, params(`${mes}-01`, fim)),
    pool.query(`${sel} WHERE data >= $1 AND data < $2 ${filtroConta}`, params(ini3, `${mes}-01`)),
  ]);
  // Saldo: uma conta → direto; todas → soma das contas do mês, só se todas têm saldo no fim do mês.
  let saldoRef = null;
  const contas = contaId ? [contaId] : [...new Set(lancs.map((l) => l.conta_id))];
  const refs = await Promise.all(contas.map((c) => saldoFimDoMes(c, fim)));
  if (refs.length === 1 && refs[0]) saldoRef = refs[0];
  else if (refs.length > 1 && refs.every((r) => r && !r.parcial)) saldoRef = { valor: refs.reduce((a, r) => a + r.valor, 0), data: fim };
  const resumo = resumoMes({ mes, lancs, anteriores, saldoRef });
  resumo.saldo.parcial = !!(saldoRef && saldoRef.parcial);
  return resumo;
}

// Grava o resumo de cada mês em ofx_resumos_mensais (visão mês a mês). Sem
// `meses` → todos os meses com lançamento. Regrava "todas as contas" (0) e
// cada conta com movimento no mês. Saldo de meses antigos pode mudar quando
// entra um extrato mais novo, por isso a importação regrava todos.
async function salvarResumosMensais(meses) {
  const { rows } = await pool.query(
    `SELECT to_char(data, 'YYYY-MM') AS mes, array_agg(DISTINCT conta_id) AS contas FROM ofx_lancamentos
      ${meses ? 'WHERE to_char(data, \'YYYY-MM\') = ANY($1)' : ''} GROUP BY 1 ORDER BY 1`, meses ? [meses] : []);
  for (const { mes, contas } of rows) {
    for (const contaId of [0, ...contas]) {
      const r = await montarResumo(mes, contaId);
      const cats = (l) => l.map((c) => ({ categoria: c.categoria, total: c.total }));
      await pool.query(
        `INSERT INTO ofx_resumos_mensais (mes, conta_id, entradas, saidas, resultado, saldo_inicial, saldo_final, menor_saldo, tarifas, lancamentos, sem_categoria, categorias, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (mes, conta_id) DO UPDATE SET entradas = EXCLUDED.entradas, saidas = EXCLUDED.saidas, resultado = EXCLUDED.resultado,
           saldo_inicial = EXCLUDED.saldo_inicial, saldo_final = EXCLUDED.saldo_final, menor_saldo = EXCLUDED.menor_saldo, tarifas = EXCLUDED.tarifas,
           lancamentos = EXCLUDED.lancamentos, sem_categoria = EXCLUDED.sem_categoria, categorias = EXCLUDED.categorias, atualizado_em = now()`,
        [mes, contaId, r.totais.entradas, r.totais.saidas, r.totais.resultado, r.saldo.inicial, r.saldo.final, r.saldo.menor ? r.saldo.menor.saldo : null,
          r.tarifas.total, r.periodo.lancamentos, (r.alertas.find((a) => a.tipo === 'sem_categoria') || {}).qtd || 0,
          JSON.stringify({ entradas: cats(r.categorias.entradas), saidas: cats(r.categorias.saidas) })]);
    }
  }
  return rows.length;
}

// GET /mensal?conta_id= → resumos salvos (até 24 meses, do mais antigo ao mais novo).
router.get('/mensal', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM (SELECT mes, entradas::float, saidas::float, resultado::float, saldo_inicial::float, saldo_final::float, menor_saldo::float,
                             tarifas::float, lancamentos, sem_categoria, categorias, atualizado_em
                        FROM ofx_resumos_mensais WHERE conta_id = $1 ORDER BY mes DESC LIMIT 24) x ORDER BY mes`, [Number(req.query.conta_id) || 0]);
    res.json({ meses: rows });
  } catch (e) { console.error('[extrato-ofx] mensal', e.message); res.status(500).json({ error: e.message }); }
});

// POST /mensal/recalcular → regrava todos os meses (botão da tela).
router.post('/mensal/recalcular', async (req, res) => {
  try { res.json({ ok: true, meses: await salvarResumosMensais() }); }
  catch (e) { console.error('[extrato-ofx] recalcular', e.message); res.status(500).json({ error: e.message }); }
});

// GET /resumo?mes=YYYY-MM&conta_id= → números da tela + última análise da IA salva.
router.get('/resumo', async (req, res) => {
  try {
    const mes = String(req.query.mes || ''); const contaId = Number(req.query.conta_id) || 0;
    if (!MES_RE.test(mes)) return res.status(400).json({ error: 'mês inválido (use AAAA-MM)' });
    const [resumo, { rows: [ia] }] = await Promise.all([
      montarResumo(mes, contaId),
      pool.query('SELECT analise, gerado_em FROM ofx_analises_ia WHERE mes = $1 AND conta_id = $2', [mes, contaId]),
    ]);
    res.json({ ...resumo, ia: ia ? { ...ia.analise, gerado_em: ia.gerado_em } : null, ia_configurada: llm.isConfigured() });
  } catch (e) { console.error('[extrato-ofx] resumo', e.message); res.status(500).json({ error: e.message }); }
});

// GET /lancamentos?mes=&conta_id=&categoria=&sentido=entrada|saida
router.get('/lancamentos', async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!MES_RE.test(mes)) return res.status(400).json({ error: 'mês inválido (use AAAA-MM)' });
    const p = [`${mes}-01`, fimDoMes(mes)]; const w = ['l.data >= $1', 'l.data <= $2'];
    if (Number(req.query.conta_id)) { p.push(Number(req.query.conta_id)); w.push(`l.conta_id = $${p.length}`); }
    if (req.query.categoria) { p.push(String(req.query.categoria)); w.push(`COALESCE(l.categoria, 'sem_categoria') = $${p.length}`); }
    if (req.query.sentido === 'entrada') w.push('l.valor > 0'); else if (req.query.sentido === 'saida') w.push('l.valor < 0');
    const { rows } = await pool.query(
      `SELECT l.id, l.data, l.valor::float AS valor, l.descricao, l.contraparte, l.contraparte_chave, l.categoria, l.categoria_origem,
              COALESCE(c.apelido, c.banco_nome, 'Banco ' || c.banco_id) AS banco
         FROM ofx_lancamentos l JOIN ofx_contas c ON c.id = l.conta_id
        WHERE ${w.join(' AND ')} ORDER BY l.data DESC, l.id DESC LIMIT 3000`, p);
    res.json({ lancamentos: rows });
  } catch (e) { console.error('[extrato-ofx] lancamentos', e.message); res.status(500).json({ error: e.message }); }
});

// PATCH /lancamentos/:id { categoria, apelido?, aplicar_todos=true } → corrige e
// ensina: a mesma contraparte (passado e futuro) passa a usar a categoria/nome.
router.patch('/lancamentos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const categoria = req.body.categoria != null ? String(req.body.categoria) : null;
  const apelido = req.body.apelido != null ? String(req.body.apelido).trim().slice(0, 80) : null;
  if (categoria && !POR_ID[categoria]) return res.status(400).json({ error: 'categoria inválida' });
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const { rows: [l] } = await cx.query('SELECT id, valor::float AS valor, contraparte_chave FROM ofx_lancamentos WHERE id = $1 FOR UPDATE', [id]);
    const mesesAfetados = l ? (await cx.query(`SELECT DISTINCT to_char(data, 'YYYY-MM') AS mes FROM ofx_lancamentos WHERE id = $1 OR contraparte_chave = $2`, [id, l.contraparte_chave])).rows.map((x) => x.mes) : [];
    if (!l) { await cx.query('ROLLBACK'); return res.status(404).json({ error: 'lançamento não encontrado' }); }
    const cat = categoria && POR_ID[categoria];
    if (cat && cat.sentido !== 'ambos' && (cat.sentido === 'entrada') !== (l.valor > 0)) { await cx.query('ROLLBACK'); return res.status(400).json({ error: `"${cat.nome}" é categoria de ${cat.sentido === 'saida' ? 'saída' : 'entrada'} — este lançamento é ${l.valor > 0 ? 'entrada' : 'saída'}.` }); }
    let afetados = 1;
    if (categoria) await cx.query(`UPDATE ofx_lancamentos SET categoria = $2, categoria_origem = 'manual' WHERE id = $1`, [id, categoria]);
    if (req.body.aplicar_todos !== false && l.contraparte_chave) {
      await cx.query(
        `INSERT INTO ofx_regras (contraparte_chave, categoria, apelido, atualizado_por, atualizado_em) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (contraparte_chave) DO UPDATE SET categoria = COALESCE(EXCLUDED.categoria, ofx_regras.categoria),
           apelido = COALESCE(EXCLUDED.apelido, ofx_regras.apelido), atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
        [l.contraparte_chave, categoria, apelido || null, quem(req)]);
      if (categoria) {
        // Só no mesmo sentido (entrada/saída) — "ambos" vale pros dois.
        const sinal = cat.sentido === 'ambos' ? '' : (l.valor > 0 ? 'AND valor > 0' : 'AND valor < 0');
        const r = await cx.query(`UPDATE ofx_lancamentos SET categoria = $2, categoria_origem = 'aprendido'
                                   WHERE contraparte_chave = $1 AND id <> $3 AND categoria_origem <> 'manual' ${sinal}`, [l.contraparte_chave, categoria, id]);
        afetados += r.rowCount;
      }
      if (apelido) await cx.query('UPDATE ofx_lancamentos SET contraparte = $2 WHERE contraparte_chave = $1', [l.contraparte_chave, apelido]);
    } else if (apelido) await cx.query('UPDATE ofx_lancamentos SET contraparte = $2 WHERE id = $1', [id, apelido]);
    await cx.query('COMMIT');
    try { await salvarResumosMensais(mesesAfetados); } catch (e) { console.error('[extrato-ofx] resumo mensal', e.message); }
    res.json({ ok: true, afetados });
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    console.error('[extrato-ofx] patch', e.message); res.status(500).json({ error: e.message });
  } finally { cx.release(); }
});

// Texto que vai pra IA: só números já calculados + nomes de contraparte (nunca nº de conta/agência).
function paraIa(r) {
  const R = (n) => (n == null ? null : Math.round(n));
  return {
    mes: r.mes, totais: r.totais, tarifas: r.tarifas,
    saldo: { inicial: r.saldo.inicial, final: r.saldo.final, menor: r.saldo.menor && { data: r.saldo.menor.data, valor: r.saldo.menor.saldo } },
    entradas_por_categoria: r.categorias.entradas.map((c) => ({ categoria: c.nome, total: R(c.total), pct: c.pct, fora_do_total: c.fora })),
    saidas_por_categoria: r.categorias.saidas.map((c) => ({ categoria: c.nome, total: R(c.total), pct: c.pct, fora_do_total: c.fora })),
    maior_saida_dia: r.maior_saida_dia, maior_entrada_dia: r.maior_entrada_dia,
    para_quem_mais_saiu: r.destinatarios.map((d) => ({ nome: d.nome, categoria: POR_ID[d.categoria]?.nome, vezes: d.vezes, total: R(d.total), mes_anterior: R(d.total_ant) })),
    de_quem_mais_entrou: r.origens.map((d) => ({ nome: d.nome, categoria: POR_ID[d.categoria]?.nome, vezes: d.vezes, total: R(d.total) })),
    recorrentes: r.recorrentes.map((x) => ({ nome: x.nome, dia: x.dia, valor_medio: R(x.valor_medio), meses: x.meses })),
    alertas: r.alertas.map(({ ids, id, ...a }) => a),
  };
}

// POST /analise-ia { mes, conta_id } → gera, salva e devolve { pontos[], recomendacoes[], gerado_em }.
router.post('/analise-ia', async (req, res) => {
  try {
    const mes = String(req.body.mes || ''); const contaId = Number(req.body.conta_id) || 0;
    if (!MES_RE.test(mes)) return res.status(400).json({ error: 'mês inválido (use AAAA-MM)' });
    if (!llm.isConfigured()) return res.status(400).json({ error: 'IA não configurada — defina ANTHROPIC_API_KEY no .env do servidor.' });
    const r = await montarResumo(mes, contaId);
    if (!r.periodo.lancamentos) return res.status(400).json({ error: 'Sem lançamentos neste mês — importe o extrato antes.' });
    const out = await llm.completeJson({
      feature: 'extrato_ofx', maxTokens: 1800,
      system: 'Você é o analista financeiro de uma empresa de e-commerce (vende no Mercado Livre e Shopee). Analisa o extrato bancário do mês e fala direto com o dono, em português do Brasil, frases curtas e práticas. Use SOMENTE os números do JSON recebido — nunca invente, nunca recalcule de outro jeito. Valores em reais no formato R$ 12.345 (sem centavos quando passar de mil). Categorias "fora_do_total" (entre contas, aplicação) não são receita nem despesa. Se "PIX/TED recebido (identificar)" ou "Sem categoria" forem grandes, diga que vale classificar na tela pra análise ficar melhor.',
      user: `Extrato do mês (JSON):\n${JSON.stringify(paraIa(r))}\n\nResponda SÓ com JSON: {"pontos": ["até 6 observações mais importantes, a mais relevante primeiro; use **negrito** no trecho-chave"], "recomendacoes": ["até 4 ações concretas"]}`,
    });
    const analise = { pontos: (out.pontos || []).slice(0, 6).map(String), recomendacoes: (out.recomendacoes || []).slice(0, 4).map(String) };
    const { rows: [s] } = await pool.query(
      `INSERT INTO ofx_analises_ia (mes, conta_id, analise, modelo, gerado_em) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (mes, conta_id) DO UPDATE SET analise = EXCLUDED.analise, modelo = EXCLUDED.modelo, gerado_em = now()
       RETURNING gerado_em`, [mes, contaId, JSON.stringify(analise), llm.DEFAULT_MODEL]);
    res.json({ ...analise, gerado_em: s.gerado_em });
  } catch (e) { console.error('[extrato-ofx] analise-ia', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports._interno = { importarConta, montarResumo, paraIa, salvarResumosMensais };
