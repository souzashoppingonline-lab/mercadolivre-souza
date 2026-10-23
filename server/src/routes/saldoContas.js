// Saldo das contas bancárias pra janela de Pagar da Dívidas do Dia — a partir
// do saldo INFORMADO por quem paga (o Fluxo de Caixa sozinho não sabe o saldo
// real: a maioria das entradas não tem conta). Montada em
// /api/financeiro/saldo-contas, ANTES de /api/financeiro (mesmo gate do módulo
// Financeiro). Informes em conta_saldos_informados (Postgres, migrate-v118);
// movimentos em cash_flow_entries (Supabase). Cálculo em saldoContas.js.
const express = require('express');
const pool = require('../db/pool');
const supa = require('../db/supabaseFin');
const { calcularSaldo } = require('../saldoContas');

const router = express.Router();

async function saldoDaConta(conta, informado) {
  const movimentos = informado
    ? await supa.get(`/cash_flow_entries?conta_bancaria_id=eq.${encodeURIComponent(conta.id)}&created_at=gt.${encodeURIComponent(new Date(informado.informado_em).toISOString())}&select=type,value,created_at&limit=1000`)
    : [];
  return { conta_id: conta.id, nome: conta.nome || conta.banco_nome || 'Conta', ...calcularSaldo(informado, Array.isArray(movimentos) ? movimentos : []) };
}

async function ultimosInformes() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (conta_id) conta_id, valor, informado_em, informado_por
     FROM conta_saldos_informados ORDER BY conta_id, informado_em DESC`
  );
  return Object.fromEntries(rows.map(r => [r.conta_id, r]));
}

// GET /api/financeiro/saldo-contas → [{ conta_id, nome, informado, informado_em,
// informado_por, saidas, entradas, disponivel, desatualizado }] (contas ativas)
router.get('/', async (req, res) => {
  try {
    const [contas, inf] = await Promise.all([supa.get('/contas_bancarias?select=id,nome,banco_nome,ativa&limit=1000'), ultimosInformes()]);
    const ativas = (Array.isArray(contas) ? contas : []).filter(c => c.ativa !== false);
    res.json(await Promise.all(ativas.map(c => saldoDaConta(c, inf[c.id] || null))));
  } catch (e) {
    console.error('[api/saldo-contas] GET', e.message);
    res.status(e.code === 'NOT_CONFIGURED' ? 503 : (e.status || 500)).json({ error: e.message });
  }
});

// POST /api/financeiro/saldo-contas { conta_id, valor } → saldo da conta já recalculado
router.post('/', async (req, res) => {
  try {
    const contaId = String((req.body && req.body.conta_id) || '');
    const valor = Math.round(Number(req.body && req.body.valor) * 100) / 100;
    if (!Number.isFinite(valor) || Math.abs(valor) >= 1e10) return res.status(400).json({ error: 'valor inválido' });
    if (!/^[0-9a-f-]{36}$/i.test(contaId)) return res.status(400).json({ error: 'conta inválida' });
    const contas = await supa.get(`/contas_bancarias?id=eq.${encodeURIComponent(contaId)}&select=id,nome,banco_nome,ativa`);
    if (!Array.isArray(contas) || !contas.length) return res.status(404).json({ error: 'conta não encontrada' });
    const { rows } = await pool.query(
      `INSERT INTO conta_saldos_informados (conta_id, valor, informado_por) VALUES ($1, $2, $3)
       RETURNING conta_id, valor, informado_em, informado_por`,
      [contaId, valor, (req.staffUser && req.staffUser.username) || null]
    );
    res.json(await saldoDaConta(contas[0], rows[0]));
  } catch (e) {
    console.error('[api/saldo-contas] POST', e.message);
    res.status(e.code === 'NOT_CONFIGURED' ? 503 : (e.status || 500)).json({ error: e.message });
  }
});

module.exports = router;
