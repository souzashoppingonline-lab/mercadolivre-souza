// Diagnóstico de configuração Shopee — verifique se as credenciais estão corretas

const env = require('./src/config/env');

console.log('\n=== DIAGNÓSTICO: CONFIGURAÇÃO SHOPEE ===\n');

const checks = [
  {
    name: 'SHOPEE_PARTNER_ID',
    value: env.shopee.partnerId,
    expected: '2039090 (produção)',
    ok: env.shopee.partnerId === '2039090',
  },
  {
    name: 'SHOPEE_PARTNER_KEY',
    value: env.shopee.partnerKey ? '✓ configurado' : '❌ NÃO CONFIGURADO',
    expected: 'chave live da API',
    ok: !!env.shopee.partnerKey,
  },
  {
    name: 'SHOPEE_REDIRECT_URI',
    value: env.shopee.redirectUri || '❌ NÃO CONFIGURADO',
    expected: 'https://multimixvendas.duckdns.org/auth/shopee/callback',
    ok: env.shopee.redirectUri === 'https://multimixvendas.duckdns.org/auth/shopee/callback',
  },
  {
    name: 'SHOPEE_ENV',
    value: env.shopee.env,
    expected: 'production',
    ok: env.shopee.env === 'production',
  },
];

let allOk = true;
checks.forEach(check => {
  const status = check.ok ? '✓' : '❌';
  console.log(`${status} ${check.name}`);
  console.log(`   valor:     ${check.value}`);
  console.log(`   esperado:  ${check.expected}`);
  if (!check.ok) allOk = false;
  console.log();
});

if (allOk) {
  console.log('✓ Configuração CORRETA — as credenciais Shopee estão pronta para produção.');
  console.log('  Reinicie o worker (npm run worker) para que o polling comece a rodar.\n');
} else {
  console.log('❌ Configuração INCOMPLETA — Shopee não funcionará até corrigir.\n');
  console.log('AÇÃO NECESSÁRIA:');
  console.log('1. Abra server/.env em produção (não este arquivo — só exemplos abaixo)');
  console.log('2. Configure as 4 variáveis acima com os valores da Shopee');
  console.log('3. Reinicie o servidor Node + worker\n');
  console.log('VALORES ESPERADOS (verificar no https://open.shopee.com):\n');
  console.log('  SHOPEE_PARTNER_ID=2039090');
  console.log('  SHOPEE_PARTNER_KEY=<sua chave de API live — não compartilhe>');
  console.log('  SHOPEE_REDIRECT_URI=https://multimixvendas.duckdns.org/auth/shopee/callback');
  console.log('  SHOPEE_ENV=production\n');
}
