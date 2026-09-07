// Diagnóstico: confirma ONDE um lançamento de despesa foi gravado de fato —
// existem DOIS lugares no módulo Financeiro com um tipo "Custo Fixo":
//   1. pages/financeiro-despesas.html → tabela `expenses` (type='fixed')
//      → É A ÚNICA que alimenta financeiro-dre.html (lê expenses direto).
//   2. pages/financeiro-boletos.html → tabela `boletos_mensais` (tipo='custo_fixo')
//      → Alimenta só a tela de Boletos/Contas a Pagar, NUNCA o DRE.
// Se o usuário lançou pelo caminho 2 achando que ia aparecer no DRE, o
// "bug" é essa ambiguidade de UI, não um erro de cálculo. Ver .claude/
// modules.md e .claude/decisions.md.
//
// Uso (rodar NO SERVIDOR, onde o .env do Financeiro/Supabase está configurado):
//   node server/scripts/verificarDespesa.js <termo de busca na descrição>
// Ex.: node server/scripts/verificarDespesa.js "vale ref"
const supa = require('../src/db/supabaseFin');

async function main() {
  const termo = process.argv.slice(2).join(' ').trim().toLowerCase();
  if (!termo) {
    console.error('Uso: node server/scripts/verificarDespesa.js <termo de busca na descrição>');
    process.exit(1);
  }

  if (!supa.isConfigured()) {
    console.error('Módulo Financeiro não configurado (env.financeiro.supabaseUrl/supabaseKey ausentes no .env).');
    process.exit(1);
  }

  console.log(`Buscando "${termo}" em expenses e boletos_mensais...\n`);

  const [expenses, boletos] = await Promise.all([
    supa.selectRows('expenses', 5000, 'date.desc'),
    supa.selectRows('boletos_mensais', 5000, 'date.desc'),
  ]);

  const achouExpenses = (expenses || []).filter((e) => String(e.description || '').toLowerCase().includes(termo));
  const achouBoletos = (boletos || []).filter((b) => String(b.name || '').toLowerCase().includes(termo));

  console.log(`── expenses (alimenta o DRE) ── ${achouExpenses.length} encontrado(s)`);
  achouExpenses.forEach((e) => {
    console.log(`  id=${e.id} desc="${e.description}" type=${e.type} value=${e.value} month=${e.month} year=${e.year} date=${e.date} category_id=${e.category_id || '—'}`);
  });

  console.log(`\n── boletos_mensais (NÃO alimenta o DRE, só Boletos/Contas a Pagar) ── ${achouBoletos.length} encontrado(s)`);
  achouBoletos.forEach((b) => {
    console.log(`  id=${b.id} name="${b.name}" tipo=${b.tipo} value=${b.value} date=${b.date} mes_referencia=${b.mes_referencia || '—'} status=${b.status}`);
  });

  console.log('\nSe o lançamento só apareceu em boletos_mensais, é isso: precisa ser refeito em financeiro-despesas.html (aba Custo Fixo) pra entrar no DRE.');
  console.log('Se apareceu em expenses mas com month/year diferentes do mês que a tela do DRE está mostrando, é só trocar o mês selecionado no DRE — não é bug.');
  console.log('Se não apareceu em NENHUM dos dois, o lançamento não foi gravado — verificar se a tela mostrou algum erro (vermelho) no momento de "Confirmar e gravar".');
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
