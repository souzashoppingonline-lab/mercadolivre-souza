// Camada de IA (Fase 2) da Inteligência de Margem — SÓ interpreta em texto o
// JSON que o motor determinístico (routes/bi.js → computarMargem) já
// calculou. Nunca recalcula margem, nunca inventa número: se um dado não
// estiver no contexto enviado, a instrução é dizer isso, não estimar.
// Mesmo padrão de custo/modelo de server/src/ai/llm.js (Haiku, barato) — ver
// .claude/analise-produtos.md (Fase 3) e .claude/decisions.md.
const { completeJson } = require('./llm');

const SYSTEM = `Você é um analista financeiro sênior de e-commerce, especialista em marketplaces (Mercado Livre).
Você recebe um JSON com números JÁ CALCULADOS por um motor determinístico — nunca invente, corrija ou recalcule nenhum valor. Se faltar dado pra alguma conclusão, diga isso explicitamente em vez de estimar.
Responda em português do Brasil, direto, sem jargão de consultoria, e SOMENTE em JSON válido no formato exato:
{
  "resumo_executivo": "2 a 4 frases sobre a saúde financeira do período, citando os números do resumo.",
  "causa_raiz": "explica a variação de margem (resumo.causa_variacao) em texto corrido: qual componente pesou mais, e se o indicador de mix piorou ou melhorou.",
  "o_que_eu_faria_agora": ["3 a 5 ações concretas e priorizadas, cada uma citando o produto e o número que a justifica"]
}
Nunca cite um valor que não esteja no JSON recebido.`;

async function gerarNarrativa(contexto) {
  const user = `Dados do período (JSON já calculado — não recalcule nada):\n${JSON.stringify(contexto)}`;
  return completeJson({ system: SYSTEM, user, maxTokens: 1400, feature: 'margem-narrativa' });
}

module.exports = { gerarNarrativa };
