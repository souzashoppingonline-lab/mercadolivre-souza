// Análise Tributária (v186) — rotas da página pages/financeiro-analise-tributaria.html.
// Montadas em /api/financeiro/tributario ANTES de /api/financeiro (mesmo gate de
// admin do módulo — ver MODULES em routes/staffAuth.js). Regras puras em
// ../tributario.js. Detalhes: .claude/analise-tributaria.md.
//   GET  /resumo?empresa=           → Simples por empresa (RBT12, faixa, alíquota) + grupo + lojas × empresa
//   GET  /estados?dias=&empresa=    → vendas por estado (pedidos e faturamento, nº e %)
//   GET  /fornecedores?empresa=     → créditos por fornecedor (relê os XMLs de compra guardados)
//   PATCH /lojas { mapa }            → grava o vínculo loja → empresa (app_config)
const express = require('express');
const pool = require('../db/pool');
const supa = require('../db/supabaseFin');
const { cached } = require('../db/cached');
const redis = require('../db/redis');
const trib = require('../tributario');

const router = express.Router();
const CHAVE_MAPA = 'tributario_lojas_empresa';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Empresas (CNPJ) = lojas do Supabase Financeiro, menos as de canal ("SHOPEE R SOUZA",
// "TIKTOK SHOP UNIFULL", "AMAZON RSOUZA" — canal + nome da empresa).
async function empresasFin() {
  if (!supa.isConfigured()) return [];
  const rows = await supa.selectRows('stores', 200).catch(() => []);
  return (rows || []).filter((s) => s.ativa !== false && !/^(SHOPEE|TIKTOK|AMAZON)\s+\S/i.test(String(s.name || '').trim()))
    .map((s) => ({ id: s.id, nome: String(s.name).trim(), cnpj: s.cnpj || null, razao_social: s.razao_social || null }));
}

// Lojas do marketplace (Postgres local) + empresa de cada uma: a gravada pelo
// usuário, senão a sugestão pelo apelido (`sugerirEmpresa`).
async function lojasComEmpresa(empresas) {
  const [{ rows: lojas }, { rows: cfg }] = await Promise.all([
    pool.query(`SELECT s.id, s.nickname, COALESCE(m.code, 'ML') AS mkt FROM stores s LEFT JOIN marketplaces m ON m.id = s.marketplace_id ORDER BY s.id`),
    pool.query(`SELECT value FROM app_config WHERE key = $1`, [CHAVE_MAPA]),
  ]);
  let mapa = {};
  try { mapa = JSON.parse(cfg[0]?.value || '{}') || {}; } catch (_) { mapa = {}; }
  const nomes = empresas.map((e) => e.nome);
  return lojas.map((l) => {
    const gravada = Object.prototype.hasOwnProperty.call(mapa, String(l.id)) ? mapa[String(l.id)] : undefined;
    return { store_id: l.id, nickname: l.nickname, mkt: l.mkt,
      empresa: gravada !== undefined ? (gravada || null) : trib.sugerirEmpresa(l.nickname, nomes),
      sugerida: gravada === undefined };
  });
}
const idsDaEmpresa = (lojas, empresa) => lojas.filter((l) => !empresa || l.empresa === empresa).map((l) => l.store_id);

router.get('/resumo', async (req, res) => {
  try {
    const empresas = await empresasFin();
    const lojas = await lojasComEmpresa(empresas);
    // Receita dos últimos 12 meses por loja (pedidos não cancelados, sem Amazon). `dias` = há quantos
    // dias existe histórico dentro da janela — com menos de ~11 meses, a faixa usa a projeção anual.
    const { rows } = await pool.query(
      `SELECT o.store_id, COALESCE(SUM(o.total_amount), 0) AS receita, COUNT(*)::int AS pedidos, MIN(o.date_created) AS desde
         FROM orders o LEFT JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.status != 'cancelled' AND COALESCE(m.code, 'ML') != 'AMAZON' AND o.date_created >= now() - interval '12 months'
        GROUP BY o.store_id`);
    const porLoja = new Map(rows.map((r) => [r.store_id, r]));
    const agora = Date.now();
    const nomes = [...new Set([...empresas.map((e) => e.nome), ...lojas.map((l) => l.empresa).filter(Boolean)])];
    const resumo = nomes.map((nome) => {
      const ls = lojas.filter((l) => l.empresa === nome);
      let receita = 0, pedidos = 0, desde = null;
      for (const l of ls) { const r = porLoja.get(l.store_id); if (!r) continue; receita += Number(r.receita); pedidos += r.pedidos; if (!desde || r.desde < desde) desde = r.desde; }
      const dias = desde ? Math.max(1, Math.round((agora - new Date(desde).getTime()) / 86400000)) : 0;
      const projetada = dias && dias < 335 ? receita * 365 / dias : receita;
      const info = empresas.find((e) => e.nome === nome) || {};
      return { empresa: nome, cnpj: info.cnpj || null, razao_social: info.razao_social || null, lojas: ls.map((l) => l.nickname),
        receita_12m: r2(receita), pedidos_12m: pedidos, dias_historico: dias, projetada: dias && dias < 335, rbt12: r2(projetada),
        simples: trib.faixaSimples(projetada) };
    }).filter((e) => e.lojas.length || e.receita_12m).sort((a, b) => b.rbt12 - a.rbt12);
    const somaGrupo = resumo.reduce((s, e) => s + e.rbt12, 0);
    const semEmpresa = lojas.filter((l) => !l.empresa).map((l) => ({ ...l, receita_12m: r2(porLoja.get(l.store_id)?.receita || 0) }));
    res.json({
      empresas: resumo,
      grupo: { rbt12: r2(somaGrupo), sublimite: trib.SUBLIMITE_SP, teto: trib.TETO_SIMPLES,
        acima_sublimite: somaGrupo > trib.SUBLIMITE_SP, acima_teto: somaGrupo > trib.TETO_SIMPLES,
        pct_sublimite: Math.round((somaGrupo / trib.SUBLIMITE_SP) * 1000) / 10 },
      lojas, empresas_disponiveis: nomes, sem_empresa: semEmpresa, tabela_simples: trib.SIMPLES_ANEXO_I,
    });
  } catch (e) { console.error('[tributario/resumo]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/estados', async (req, res) => {
  try {
    const dias = Math.min(Math.max(Number(req.query.dias) || 365, 1), 730);
    const empresa = String(req.query.empresa || '');
    const lojas = await lojasComEmpresa(await empresasFin());
    const ids = idsDaEmpresa(lojas, empresa);
    if (empresa && !ids.length) return res.json({ dias, empresa, total_pedidos: 0, total_fat: 0, estados: [], sem_estado: { pedidos: 0, fat: 0 } });
    const { rows } = await pool.query(
      `SELECT NULLIF(TRIM(o.buyer_state_name), '') AS estado, COUNT(*)::int AS pedidos, COALESCE(SUM(o.total_amount), 0) AS fat
         FROM orders o LEFT JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.status != 'cancelled' AND COALESCE(m.code, 'ML') != 'AMAZON'
          AND o.date_created >= now() - ($1::int || ' days')::interval
          AND ($2::bigint[] IS NULL OR o.store_id = ANY($2::bigint[]))
        GROUP BY 1`, [dias, empresa ? ids : null]);
    const por = new Map(); let semP = 0, semF = 0;
    for (const r of rows) {
      const uf = trib.ufDe(r.estado);
      if (!uf) { semP += r.pedidos; semF += Number(r.fat); continue; }
      const o = por.get(uf) || { uf, nome: trib.UFS[uf], pedidos: 0, fat: 0 };
      o.pedidos += r.pedidos; o.fat += Number(r.fat); por.set(uf, o);
    }
    const lista = [...por.values()];
    const totP = lista.reduce((s, x) => s + x.pedidos, 0), totF = lista.reduce((s, x) => s + x.fat, 0);
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const estados = lista.map((x) => ({ ...x, fat: r2(x.fat), pct_pedidos: pct(x.pedidos, totP), pct_fat: pct(x.fat, totF),
      aliquota_interestadual: trib.aliquotaInterestadualSP(x.uf) })).sort((a, b) => b.fat - a.fat);
    const sp = estados.find((x) => x.uf === 'SP') || { pedidos: 0, fat: 0 };
    res.json({ dias, empresa, total_pedidos: totP, total_fat: r2(totF),
      dentro_sp: { pedidos: sp.pedidos, fat: r2(sp.fat), pct_fat: pct(sp.fat, totF) },
      fora_sp: { pedidos: totP - sp.pedidos, fat: r2(totF - sp.fat), pct_fat: pct(totF - sp.fat, totF), ufs: estados.length - (sp.pedidos ? 1 : 0) },
      estados, sem_estado: { pedidos: semP, fat: r2(semF), pct_pedidos: pct(semP, totP + semP) } });
  } catch (e) { console.error('[tributario/estados]', e.message); res.status(500).json({ error: e.message }); }
});

// Créditos por fornecedor: relê compras_xml.xml_original (conteúdo, ou link do
// Storage do próprio Financeiro — baixado). Cache 10 min por empresa.
async function montarFornecedores(empresa) {
  if (!supa.isConfigured()) return { configurado: false, fornecedores: [], notas: 0, erros: [] };
  const empresas = await empresasFin();
  const alvo = empresa ? empresas.find((e) => e.nome === empresa) : null;
  const rows = (await supa.selectRows('compras_xml', 2000)) || [];
  const notas = [], erros = [];
  for (const r of rows.filter((x) => !alvo || String(x.empresa_id) === String(alvo.id))) {
    try {
      let xml = String(r.xml_original || '');
      if (/^https?:\/\//i.test(xml.trim())) xml = await supa.baixarDoProprioStorage(xml.trim());
      const n = trib.parseNfe(xml);
      notas.push({ ...n, creditos: trib.creditosNota(n) });
    } catch (e) { erros.push({ nota: r.numero_nf || r.chave_nfe, fornecedor: r.razao_emitente, erro: e.message }); }
  }
  const fornecedores = trib.resumoFornecedores(notas);
  const soma = (k) => r2(fornecedores.reduce((s, f) => s + f[k], 0));
  return { configurado: true, empresa: empresa || null, notas: notas.length, erros, fornecedores,
    totais: { total_compras: soma('total_compras'), icms_destacado: soma('icms_destacado'), credito_icms: soma('credito_icms'),
      v_st: soma('v_st'), credito_pis_cofins: soma('credito_pis_cofins') } };
}
router.get('/fornecedores', async (req, res) => {
  try {
    const empresa = String(req.query.empresa || '');
    res.json(await cached(`tributario:fornecedores:${empresa || 'todas'}`, 600, () => montarFornecedores(empresa)));
  } catch (e) { console.error('[tributario/fornecedores]', e.message); res.status(500).json({ error: e.message }); }
});

router.patch('/lojas', async (req, res) => {
  try {
    const mapa = req.body && req.body.mapa;
    if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return res.status(400).json({ error: 'mapa obrigatório: { store_id: empresa }' });
    const limpo = {};
    for (const [k, v] of Object.entries(mapa)) {
      if (!/^\d+$/.test(k)) continue;
      limpo[k] = v == null ? '' : String(v).trim().slice(0, 60);
    }
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [CHAVE_MAPA, JSON.stringify(limpo)]);
    await redis.del('tributario:fornecedores:todas').catch(() => {});
    res.json({ ok: true, mapa: limpo });
  } catch (e) { console.error('[tributario/lojas]', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
