// Testes de fumaça — rodam sem banco/Redis (só análise estática), então valem
// em qualquer máquina/CI. Objetivo: pegar cedo a classe de erro que já quebrou
// deploy (arquivo que não parseia → crash-loop) e o drift entre as rotas
// críticas e os métodos de js/db.js que as consomem. Não substituem testes de
// integração HTTP (esses exigem um Postgres de teste — ver workflow.md/todo.md).
//
// Rodar: `npm test` (na pasta server/).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');

// ── 1. Cada arquivo crítico precisa parsear (node --check) ──────────────────
// É exatamente o que evita um EADDRINUSE/crash-loop servindo código velho:
// um arquivo que não compila derruba o processo inteiro no boot.
const arquivosCriticos = [
  'server.js', 'worker.js', 'health.js', 'reports.js', 'notify.js', 'mlClient.js',
  'marketplaceEventWorker.js',
  'routes/api.js', 'routes/webhookGateway.js', 'routes/staffAuth.js',
  'routes/turbo.js', 'routes/embalagem.js', 'routes/tasks.js',
  'db/migrate.js',
].map((f) => path.join(SRC, f));

for (const arquivo of arquivosCriticos) {
  test(`parseia: ${path.relative(SRC, arquivo)}`, () => {
    assert.ok(fs.existsSync(arquivo), `arquivo não encontrado: ${arquivo}`);
    execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' });
  });
}

test('parseia: js/db.js e js/layout.js (frontend)', () => {
  for (const f of ['js/db.js', 'js/layout.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  }
});

// ── 2. Rotas críticas continuam registradas ─────────────────────────────────
// Se alguém renomear/apagar uma dessas, a tela correspondente quebra em
// silêncio. O teste falha antes do deploy.
test('rotas críticas registradas em routes/api.js', () => {
  const api = read(path.join(SRC, 'routes', 'api.js'));
  const rotas = [
    "'/vendas/margem'", "'/vendas/detalhado'", "'/vendas/por-loja'",
    "'/sistema/saude'", "'/conciliacao/pagamentos'",
  ];
  for (const r of rotas) {
    assert.ok(api.includes(`router.get(${r}`), `rota ausente em api.js: GET ${r}`);
  }
});

test('auth de staff expõe login + middleware', () => {
  const auth = read(path.join(SRC, 'routes', 'staffAuth.js'));
  assert.ok(/requireStaffAuth/.test(auth), 'requireStaffAuth ausente');
  assert.ok(/router\.(post|get)\('\/login'|'\/login'/.test(auth), 'rota /login ausente');
});

// ── 3. Contrato frontend↔backend: métodos de js/db.js que as telas críticas usam ─
test('js/db.js expõe os métodos das telas críticas', () => {
  const db = read(path.join(ROOT, 'js', 'db.js'));
  const metodos = [
    'getMargemContribuicao', 'getVendasPorLoja', 'getSaudeSistema',
    'getConciliacaoPagamentos', 'excluirPergunta',
  ];
  for (const m of metodos) {
    assert.ok(db.includes(m), `método ausente em js/db.js: ${m}`);
  }
});

// ── 4. Fonte única da Margem: a rota não deve reimplementar o SQL ────────────
// Garante que /vendas/margem consome getMargemPorLoja (reports.js) em vez de
// duplicar a query (regra anti-duplicação do projeto — ver workflow.md).
test('/vendas/margem usa getMargemPorLoja (sem SQL duplicado)', () => {
  const api = read(path.join(SRC, 'routes', 'api.js'));
  const reports = read(path.join(SRC, 'reports.js'));
  assert.ok(/getMargemPorLoja/.test(reports), 'getMargemPorLoja ausente em reports.js');
  assert.ok(api.includes('getMargemPorLoja('), 'rota /vendas/margem não usa getMargemPorLoja');
});
