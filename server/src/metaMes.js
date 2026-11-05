// v164 — Meta do mês (slide 🎯): PURA, testada. Meta = linha geral de monthly_goals
// (store_id vazio) do mês; sem ela, soma das metas por loja (mesma regra de
// globalGoal() em financeiro-vendas.html). Faturado vem dos pedidos (tempo real).
// `hoje` = Date do dia em SP (só ano/mês/dia importam).
function calcularMeta(goals, faturado, hoje) {
  const m = hoje.getMonth() + 1, y = hoje.getFullYear();
  const doMes = (goals || []).filter((g) => Number(g.month) === m && Number(g.year) === y);
  const geral = doMes.find((g) => !g.store_id);
  const meta = geral ? Number(geral.goal_value) || 0 : doMes.reduce((a, g) => a + (Number(g.goal_value) || 0), 0);
  if (!(meta > 0)) return null;
  const diasMes = new Date(y, m, 0).getDate(), dia = hoje.getDate();
  const restantes = diasMes - dia + 1;                 // conta o dia de hoje
  const falta = Math.max(0, meta - faturado);
  return {
    meta, faturado, falta, pct: Math.round((faturado / meta) * 1000) / 10,
    dias_mes: diasMes, dia, dias_restantes: restantes,
    por_dia: restantes > 0 ? falta / restantes : falta,
    projecao: dia > 1 ? (faturado / (dia - 1 + 0.5)) * diasMes : null,   // meio dia de hoje como fração (ritmo aproximado)
    ritmo_ideal_ate_hoje: (meta / diasMes) * dia,
  };
}

module.exports = { calcularMeta };
