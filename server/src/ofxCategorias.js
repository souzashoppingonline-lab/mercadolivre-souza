// Categorias do Extrato Bancário (OFX) + classificação automática (PURO —
// testado em test/ofxCategorias.test.js). Ordem de decisão:
//   1. regra aprendida (ofx_regras: o usuário corrigiu essa contraparte antes)
//   2. palavras-chave abaixo (descrições reais do Santander/Itaú/BB/Inter…)
//   3. sem_categoria (a tela pede pra escolher)
// `fora` = não entra no total de entradas/saídas (dinheiro que só trocou de
// conta ou foi pra aplicação — senão inflaria receita e despesa).
// Ver .claude/extrato-ofx.md.

const CATEGORIAS = [
  // Entradas
  { id: 'repasse_marketplace', sentido: 'entrada', ico: '🟡', nome: 'Repasse de marketplace' },
  { id: 'pix_recebido', sentido: 'entrada', ico: '⚡', nome: 'PIX/TED recebido (identificar)' },
  { id: 'clientes', sentido: 'entrada', ico: '🧑‍💼', nome: 'Clientes' },
  { id: 'rendimentos', sentido: 'entrada', ico: '📈', nome: 'Rendimentos' },
  { id: 'estornos', sentido: 'entrada', ico: '↩️', nome: 'Estornos / devoluções' },
  { id: 'outros_entrada', sentido: 'entrada', ico: '💼', nome: 'Outras entradas' },
  // Saídas
  { id: 'fornecedores', sentido: 'saida', ico: '📦', nome: 'Fornecedores' },
  { id: 'impostos', sentido: 'saida', ico: '🏛️', nome: 'Impostos' },
  { id: 'folha', sentido: 'saida', ico: '👥', nome: 'Folha / pró-labore' },
  { id: 'cartao', sentido: 'saida', ico: '💳', nome: 'Fatura de cartão' },
  { id: 'emprestimo', sentido: 'saida', ico: '🏦', nome: 'Empréstimo / financiamento' },
  { id: 'frete', sentido: 'saida', ico: '🚚', nome: 'Frete / logística' },
  { id: 'aluguel', sentido: 'saida', ico: '🏢', nome: 'Aluguel / condomínio' },
  { id: 'servicos', sentido: 'saida', ico: '🛠️', nome: 'Serviços (contabilidade, internet, energia, software)' },
  { id: 'seguros_saude', sentido: 'saida', ico: '🩺', nome: 'Seguros / plano de saúde' },
  { id: 'tarifas', sentido: 'saida', ico: '🧾', nome: 'Tarifas bancárias' },
  { id: 'pessoal', sentido: 'saida', ico: '🏠', nome: 'Pessoal / retirada dos sócios' },
  { id: 'outros_saida', sentido: 'saida', ico: '💼', nome: 'Outras saídas' },
  // Ambos os sentidos, fora do total
  { id: 'entre_contas', sentido: 'ambos', ico: '🔁', nome: 'Entre contas suas', fora: true },
  { id: 'investimento', sentido: 'ambos', ico: '💰', nome: 'Aplicação / resgate', fora: true },
  { id: 'sem_categoria', sentido: 'ambos', ico: '❔', nome: 'Sem categoria' },
];
const POR_ID = Object.fromEntries(CATEGORIAS.map((c) => [c.id, c]));

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();

// Prefixos de operação que vêm antes do nome de quem pagou/recebeu.
const PREFIXOS = [
  [/^PIX (RECEBIDO|REC)\b/, 'PIX_REC'], [/^PIX (ENVIADO|ENV)\b/, 'PIX_ENV'], [/^PIX\b/, 'PIX'],
  [/^PAGAMENTO DE BOLETO( OUTROS BANCOS)?\b/, 'BOLETO'], [/^(PAG|PAGTO|PGTO) (DE )?(BOLETO|TITULO|TIT)\b( OUTROS BANCOS)?/, 'BOLETO'],
  [/^(TED|DOC|TEV|TRANSF(ERENCIA)?)( (RECEBIDA|ENVIADA|ENTRE CONTAS|MESMA TIT\w*|ELETRONICA|PIX))*\b/, 'TRANSF'],
  [/^PAGAMENTO CARTAO CREDITO( BCE)?\b/, 'CARTAO'],
];
// Datas/horas que o banco cola na descrição ("01/09 14:34") e ruído de conta.
const RUIDO = /\b\d{2}\/\d{2}(\/\d{2,4})?( \d{2}:\d{2}(:\d{2})?)?\b/g;

// Contraparte (quem pagou/recebeu) + chave estável pra aprender a categoria.
// "Pix Enviado LIN RAN VARIEDADES DOMEST" → { nome:'LIN RAN VARIEDADES DOMEST', chave:'PIX_ENV|LIN RAN VARIEDADES DOMEST' }
// "Pix Recebido 53727812000108" → { nome:'CNPJ 53.727.812/0001-08', chave:'PIX_REC|53727812000108' }
function contraparte(descricao) {
  let t = norm(descricao).replace(RUIDO, ' ').replace(/\s+/g, ' ').trim();
  let op = 'OUTRO';
  for (const [re, nome] of PREFIXOS) { const m = t.match(re); if (m) { op = nome; t = t.slice(m[0].length).trim(); break; } }
  // Santander repete o começo da descrição no fim ("RENDIMENTO LIQUIDO DE CONTAMAX 7000 RENDIMENTO LIQUIDO DE CONTAMAX").
  const pal = t.split(' ');
  for (let k = Math.floor(pal.length / 2); k >= 3; k--) {
    if (pal.slice(-k).join(' ') === pal.slice(0, k).join(' ')) { t = pal.slice(0, -k).join(' '); break; }
  }
  const so = t.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const doc = so.match(/^(\d{14}|\d{11})$/);
  let nome = so || norm(descricao);
  if (doc) nome = doc[1].length === 14
    ? `CNPJ ${doc[1].replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}`
    : `CPF ${doc[1].replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}`;
  return { op, nome: nome.slice(0, 80), chave: `${op}|${(so || norm(descricao)).slice(0, 60)}` };
}

const tem = (t, re) => re.test(t);
const BANCOS = /\b(BANCO INTER|C6 BANK|ITAU UNIBANCO|BANCO DO BRASIL|NU PAGAMENTOS|NUBANK|BRADESCO|CAIXA ECONOMICA|SANTANDER|SICOOB|SICREDI|PICPAY|MERCADO PAGO|PAGSEGURO|BANCO ORIGINAL|BTG|XP INVESTIMENTOS)\b/;
const EMPRESA = /\b(LTDA|EIRELI|S\/?A|S A|ME|EPP|MEI|COMERCIO|COM|IMPORTACAO|IMPORTADORA|DISTR\w*|INDUSTRIA|IND|SERVICOS|ATACAD\w*|ARMAZENS|ALIMENTOS|ALI)\b/;

// Categoria por palavra-chave. `valor` com sinal (entrada > 0).
function categoriaPorPalavra(descricao, valor) {
  const t = norm(descricao);
  const entrada = Number(valor) > 0;
  const { op, nome } = contraparte(descricao);
  if (tem(t, /\b(TARIFA|TAR |CESTA|PACOTE SERV|IOF|ENCARGO|JUROS|MULTA|MANUT(ENCAO)? CONTA|ANUIDADE)\b/) || /^TAR\b/.test(t)) return entrada ? 'estornos' : 'tarifas';
  if (tem(t, /\b(RENDIMENTO|REND PAGO|JUROS CREDITADOS|RESGATE)\b/)) return entrada ? 'rendimentos' : 'investimento';
  if (tem(t, /\b(APLICACAO|APLIC\b|CDB|POUPANCA|INVEST)/)) return 'investimento';
  if (tem(t, /\b(ESTORNO|DEVOLUCAO|DEVOL|CANCELAMENTO)\b/) && entrada) return 'estornos';
  if (entrada) {
    if (tem(t, /\b(MERCADO ?PAGO|MERCADO ?LIVRE|EBAZAR|SHOPEE|AMAZON|TIKTOK|MAGALU|MAGAZINE LUIZA|SHEIN)\b/)) return 'repasse_marketplace';
    if (tem(t, /\b(MESMA TIT|MESMA TITULARIDADE|ENTRE CONTAS)\b/)) return 'entre_contas';
    if (op === 'PIX_REC' || op === 'PIX' || op === 'TRANSF') return 'pix_recebido';
    return 'outros_entrada';
  }
  if (tem(t, /\b(DARF|SIMPLES NACIONAL|DAS\b|TRIBUTO|ICMS|SEFAZ|GPS|FGTS|INSS|IPVA|IPTU|RECEITA FED|GNRE)\b/)) return 'impostos';
  if (op === 'CARTAO' || tem(t, /\b(FATURA|CARTAO DE CREDITO|CARTAO CREDITO)\b/)) return 'cartao';
  if (tem(t, /\b(EMPREST|FINANCIAMENTO|FINANC\b|PARC(ELA)? EMPR|CONSORCIO|CAPITAL DE GIRO)\b/)) return 'emprestimo';
  if (tem(t, /\b(SALARIO|FOLHA|PRO ?LABORE|FERIAS|RESCISAO|13O)\b/)) return 'folha';
  if (tem(t, /\b(MESMA TIT|MESMA TITULARIDADE|ENTRE CONTAS)\b/)) return 'entre_contas';
  if (tem(nome, /\b(LOGISTICA|ENTREGA|ENTREGUE|TRANSPORT\w*|CORREIOS|JADLOG|LOGGI|FRETE)\b/)) return 'frete';
  if (tem(nome, /\b(CONTABIL\w*|NET\b|MUVNET|TELECOM|VIVO|CLARO|TIM\b|OI\b|ENERGIA|ENEL|CEMIG|COPEL|CPFL|LIGHT|SABESP|SANEAMENTO|SOFTWARE|SISTEMAS|TECNOLOGIA)\b/)) return 'servicos';
  if (tem(nome, /\b(IMOVEIS|IMOBILIARIA|ALUGUEL|CONDOMINIO|ADMIN\w*)\b/)) return 'aluguel';
  if (tem(t, /\b(SEGURO|AMIL|UNIMED|BRADESCO SAUDE|SULAMERICA|HAPVIDA|ODONTO)\b/)) return 'seguros_saude';
  if (tem(nome, /\b(COLEGIO|ESCOLA|IFOOD|FARMACIA|DROGARIA)\b/)) return 'pessoal';
  // PIX/TED pra banco ou carteira digital: quase sempre conta da própria empresa (confirmar).
  if ((op === 'PIX_ENV' || op === 'TRANSF' || op === 'PIX') && tem(nome, BANCOS)) return 'entre_contas';
  if (op === 'BOLETO') return 'fornecedores';
  if ((op === 'PIX_ENV' || op === 'TRANSF' || op === 'PIX') && tem(nome, EMPRESA)) return 'fornecedores';
  return 'sem_categoria';
}

// regras: Map/objeto contraparte_chave → { categoria, apelido }.
function classificar(descricao, valor, regras = {}) {
  const cp = contraparte(descricao);
  const r = regras instanceof Map ? regras.get(cp.chave) : regras[cp.chave];
  if (r && r.categoria && POR_ID[r.categoria]) return { categoria: r.categoria, origem: 'aprendido', contraparte: r.apelido || cp.nome, contraparte_chave: cp.chave };
  return { categoria: categoriaPorPalavra(descricao, valor), origem: 'auto', contraparte: (r && r.apelido) || cp.nome, contraparte_chave: cp.chave };
}

module.exports = { CATEGORIAS, POR_ID, contraparte, categoriaPorPalavra, classificar, norm };
