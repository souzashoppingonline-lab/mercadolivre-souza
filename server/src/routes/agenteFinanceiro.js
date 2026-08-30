// Agente Financeiro — módulo Inteligência de Negócio (não Financeiro, ver
// .claude/decisions.md pra por quê): 4 relatórios sob demanda (botão) que
// cruzam Postgres operacional + Supabase Financeiro. Camada determinística em
// server/src/financeiroCalc.js + computarMargem (routes/bi.js); a IA só
// interpreta (server/src/ai/agenteFinanceiro.js). Montado em
// /api/bi/agente-financeiro no server.js — dentro do gate de MODULES.bi
// (admin, ver staffAuth.js), porque o prefixo /api/bi já cobre qualquer rota
// abaixo dele. Ver .claude/api.md e .claude/modules.md.
const express = require('express');
const calc = require('../financeiroCalc');
const { computarMargem } = require('./bi');
const agente = require('../ai/agenteFinanceiro');

const router = express.Router();

// Cada rota busca o dado determinístico e, por padrão, também pede a
// interpretação da IA (?ia=0 pula — útil pra debug/custo). Falha da IA nunca
// derruba o relatório: os números determinísticos já são a resposta válida
// por si, a interpretação é um extra.
function withIA(handler) {
  return async (req, res) => {
    try {
      const dados = await handler(req);
      let interpretacao = null, iaErro = null;
      if (String(req.query.ia) !== '0') {
        try { interpretacao = await agente.interpretar(handler.tipo, dados); }
        catch (e) { iaErro = e.message; }
      }
      res.json({ dados, interpretacao, ia_erro: iaErro });
    } catch (e) {
      console.error(`[agente-financeiro] ${handler.tipo} error:`, e.message);
      const status = e.code === 'NOT_CONFIGURED' ? 503 : (e.status || 500);
      res.status(status).json({ error: e.message });
    }
  };
}

const dre = async (req) => calc.getDRE({ mes: req.query.mes, ano: req.query.ano });
dre.tipo = 'dre';
router.get('/dre', withIA(dre));

const fluxo = async (req) => calc.getFluxoProjecao({ dias: req.query.dias });
fluxo.tipo = 'fluxo';
router.get('/fluxo', withIA(fluxo));

const contasAPagar = async () => calc.getContasAPagar();
contasAPagar.tipo = 'contas_a_pagar';
router.get('/contas-a-pagar', withIA(contasAPagar));

// Cruzamento ML × Financeiro: pega a margem REAL das vendas ML no período
// (computarMargem, Postgres — mesma função da Inteligência de Margem, nunca
// recalculada aqui) e o que foi lançado em sales_entries no MESMO período
// (Supabase). Os dois bancos não se joinam em SQL — o cruzamento é feito na
// aplicação, comparando os dois totais já prontos.
const cruzamento = async (req) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const storeId = String(req.query.store_id || '').trim();
  const ml = await computarMargem({ days, storeId });
  const fin = await calc.getSalesEntriesPeriodo({ dateFrom: ml.periodo.de, dateTo: ml.periodo.ate });
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    periodo: ml.periodo,
    mercado_livre: {
      faturamento: ml.resumo.faturamento, margem: ml.resumo.margem,
      mc_pct: ml.resumo.mc_pct, pedidos: ml.resumo.pedidos,
    },
    financeiro_lancado: fin,
    diferenca_faturamento: round2(ml.resumo.faturamento - fin.receita),
    diferenca_margem: round2(ml.resumo.margem - fin.margem),
  };
};
cruzamento.tipo = 'cruzamento_ml';
router.get('/cruzamento-ml', withIA(cruzamento));

module.exports = router;
