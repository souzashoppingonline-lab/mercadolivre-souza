// Leitura de nota fiscal / cupom / recibo por foto (v180, pedido do usuário:
// "aponto a câmera e ele lê a nota fiscal") — página pages/financeiro-despesa-celular.html.
// A foto chega já reduzida pelo celular (≤ 1600 px, JPEG), vai pra IA e NÃO é
// guardada (decisão do usuário). A IA só PREENCHE o formulário: o usuário confere
// e é a página que grava em `expenses` (mesma tabela de Despesas & DRE).
//   lerNota()        → chama a IA (ai/llm.js) com a imagem + lista de categorias
//   normalizarLeitura() → PURA (test/notaFiscalIa.test.js): valida/arruma a resposta
// Ver .claude/modules.md (Despesas pelo celular) e .claude/api.md.
// Modelo da leitura: Claude Opus 5.5 (lê melhor foto torta/amassada/cupom
// apagado); trocável por env sem deploy. Custo típico ~US$ 0,02 por foto.
const MODELO_NOTA = process.env.AI_MODEL_NOTA || 'claude-opus-5-5';
const TIPOS_MIDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BASE64 = 1_400_000; // ~1 MB de imagem; o celular já manda ~300 KB

const SISTEMA = `Você lê fotos de notas fiscais, cupons fiscais (NFC-e/SAT), recibos e boletos de despesas de uma empresa brasileira de e-commerce.
Responda SOMENTE com um objeto JSON, sem texto antes ou depois, com estes campos:
{"valor_total": número em reais (ex.: 123.45) ou null,
 "data": "AAAA-MM-DD" (data de emissão/compra) ou null,
 "fornecedor": nome de quem vendeu/emitiu (curto) ou null,
 "cnpj": CNPJ/CPF do emissor só com dígitos ou null,
 "descricao": resumo curto do que foi comprado (até 60 caracteres, ex.: "Combustível", "Fita adesiva e caixas"),
 "categoria_id": o id da categoria da lista que melhor combina, ou null se nenhuma servir,
 "tipo": "fixed" (despesa fixa recorrente: aluguel, internet, salário, contador, software) ou "operational" (gasto do dia a dia: material, combustível, frete, embalagem),
 "legivel": true se conseguiu ler o valor total com segurança, false se a foto não é uma nota ou está ilegível,
 "observacao": se algo ficou duvidoso, diga o quê em uma frase curta; senão null}
Regras: o valor_total é o TOTAL PAGO (com descontos já aplicados), nunca o subtotal de um item. Não invente: o que não estiver na foto vai como null.`;

async function lerNota({ imagemBase64, mediaType = 'image/jpeg', categorias = [] }) {
  const data = String(imagemBase64 || '').replace(/^data:[^,]+,/, '');
  if (!data) throw Object.assign(new Error('Foto vazia.'), { status: 400 });
  if (!TIPOS_MIDIA.has(mediaType)) throw Object.assign(new Error('Formato de imagem não suportado (use JPEG, PNG ou WebP).'), { status: 400 });
  if (data.length > MAX_BASE64) throw Object.assign(new Error('Foto grande demais — tente de novo (a página reduz a foto antes de enviar).'), { status: 413 });
  const lista = categorias.map((c) => `${c.id}: ${c.name}`).join('\n') || '(nenhuma categoria cadastrada)';
  const llm = require('./ai/llm'); // tardio: o módulo puro (normalizar) não carrega o banco — testável
  const bruto = await llm.completeJson({
    system: SISTEMA,
    user: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      { type: 'text', text: `Categorias de despesa disponíveis (id: nome):\n${lista}\n\nLeia a nota da foto e devolva o JSON.` },
    ],
    model: MODELO_NOTA,
    maxTokens: 4000,
    extra: { output_config: { effort: 'low' } },
    feature: 'nota_fiscal_despesa',
  });
  return normalizarLeitura(bruto, categorias);
}

// "1.234,56" / "1234.56" / 1234.56 / "R$ 99,90" → número (2 casas) ou null.
function lerValor(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let t = String(v ?? '').replace(/[R$\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Aceita AAAA-MM-DD ou DD/MM/AAAA; data impossível ou fora de 2 anos pra trás /
// 60 dias pra frente → null (o usuário escolhe).
function lerData(v, hoje = new Date()) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/), y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) [d, mo, y] = [m[1], m[2], m[3]];
  else return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  const dias = (dt - Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000;
  if (dias < -730 || dias > 60) return null;
  return `${y}-${mo}-${d}`;
}

function formatarDoc(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return null;
}

const texto = (v, n) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : null;
};

function normalizarLeitura(r, categorias = [], hoje = new Date()) {
  r = r && typeof r === 'object' ? r : {};
  const ids = new Map(categorias.map((c) => [String(c.id), c]));
  let cat = r.categoria_id != null ? ids.get(String(r.categoria_id)) : null;
  // A IA às vezes devolve o NOME em vez do id — casa pelo nome (sem acento/caixa).
  if (!cat && r.categoria_id != null) {
    const sem = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    cat = categorias.find((c) => sem(c.name) === sem(r.categoria_id)) || null;
  }
  const valor = lerValor(r.valor_total);
  return {
    valor,
    data: lerData(r.data, hoje),
    fornecedor: texto(r.fornecedor, 80),
    cnpj: formatarDoc(r.cnpj),
    descricao: texto(r.descricao, 60),
    categoria_id: cat ? cat.id : null,
    categoria_nome: cat ? cat.name : null,
    tipo: r.tipo === 'fixed' ? 'fixed' : 'operational',
    legivel: r.legivel !== false && valor != null,
    observacao: texto(r.observacao, 160),
  };
}

module.exports = { lerNota, normalizarLeitura, lerValor, lerData, formatarDoc, MODELO_NOTA };
