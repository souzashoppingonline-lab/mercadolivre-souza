// Agente Financeiro (módulo Inteligência de Negócio) — SÓ interpreta em texto
// os números já calculados por server/src/financeiroCalc.js (DRE/fluxo/contas
// a pagar) e por computarMargem (routes/bi.js, no cruzamento com o Postgres
// operacional). Nunca recalcula, nunca inventa número — mesmo padrão de
// server/src/ai/margemNarrativa.js. 4 relatórios sob demanda (botão), sem
// chat livre — decisão do usuário, ver .claude/decisions.md.
const { completeJson } = require('./llm');

const BASE_SYSTEM = `Você é um analista financeiro sênior de e-commerce. Você recebe um JSON com números JÁ CALCULADOS por um motor determinístico — nunca invente, corrija ou recalcule nenhum valor. Se faltar dado pra alguma conclusão, diga isso explicitamente em vez de estimar.
Responda em português do Brasil, direto, sem jargão de consultoria, e SOMENTE em JSON válido no formato exato:
{
  "resumo": "2 a 4 frases sobre a situação, citando os números do JSON recebido.",
  "pontos_de_atencao": ["0 a 4 pontos concretos, cada um citando o número que o justifica"],
  "recomendacao": "1 a 3 frases com a ação mais importante agora, ou string vazia se não houver nada a fazer"
}
Nunca cite um valor que não esteja no JSON recebido.`;

const INSTRUCOES = {
  dre: 'Contexto: DRE mensal do e-commerce (receita, deduções automáticas de venda, despesas cadastradas, lucro líquido, ponto de equilíbrio), comparado ao mês anterior.',
  fluxo: 'Contexto: fluxo de caixa e projeção de N dias (caixa atual, entradas/saídas previstas, saldo projetado, e em quantos dias o caixa fica negativo, se ficar).',
  contas_a_pagar: 'Contexto: contas a pagar (boletos e faturas de cartão) pendentes — vencidas, dos próximos 7 dias e dos próximos 30 dias — somadas por empresa.',
  cruzamento_ml: 'Contexto: compara a margem REAL das vendas do Mercado Livre (calculada a partir dos pedidos — fonte confiável) com o que foi lançado manualmente em "Vendas & Custos" do Financeiro no mesmo período. Aponte se os dois números batem ou divergem — só sugira uma causa se ela estiver implícita no próprio JSON (ex.: dias sem nenhum lançamento no período), nunca invente um motivo que não dá pra confirmar pelos dados.',
};

async function interpretar(tipo, dados) {
  const instrucao = INSTRUCOES[tipo];
  if (!instrucao) throw new Error(`Agente Financeiro: tipo de relatório desconhecido "${tipo}"`);
  const system = `${BASE_SYSTEM}\n\n${instrucao}`;
  const user = `Dados já calculados (não recalcule nada):\n${JSON.stringify(dados)}`;
  return completeJson({ system, user, maxTokens: 900, feature: `agente-financeiro-${tipo}` });
}

module.exports = { interpretar };
