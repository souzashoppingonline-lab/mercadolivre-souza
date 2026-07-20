// Motor de score de qualidade de anúncio Shopee — função PURA (sem banco/rede).
// Recebe o get_item_base_info bruto (shopee_item_data.raw) + a linha de items e
// devolve um score 0–100 com o detalhamento por critério (o que está bom, o que
// falta e a dica). Mesma ideia do server/src/seoScore.js do Mercado Livre, mas
// com os critérios que a Shopee valoriza (título, fotos, descrição, atributos,
// vídeo, SKU, variações/estoque). Não faz chamada — usa só o que o catálogo já
// sincronizou, então é barato rodar pra centenas de itens.

function len(s) { return String(s || '').trim().length; }

// raw = get_item_base_info; item = { title, available_quantity, ... };
// extra = { has_model, variation_count } (de shopee_item_data)
function scoreItem(raw = {}, item = {}, extra = {}) {
  const titulo = raw.item_name || item.title || '';
  const imagens = (raw.image && Array.isArray(raw.image.image_url_list)) ? raw.image.image_url_list.length : 0;
  const descricao = raw.description || '';
  const atributos = Array.isArray(raw.attribute_list) ? raw.attribute_list.length : 0;
  const temVideo = Array.isArray(raw.video_info) ? raw.video_info.length > 0 : false;
  const sku = raw.item_sku || '';
  const temVariacao = !!extra.has_model && Number(extra.variation_count || 0) > 0;
  const estoque = Number(item.available_quantity || 0);

  // Cada critério: { nome, ok, peso, dica }. Pesos somam 100.
  const criterios = [
    { nome: 'Título descritivo (25–100 caracteres)', ok: len(titulo) >= 25 && len(titulo) <= 100, peso: 20,
      dica: len(titulo) < 25 ? 'Título curto — inclua marca, modelo e palavras-chave.' : 'Título muito longo — a Shopee corta em ~100 caracteres.' },
    { nome: 'Pelo menos 3 fotos', ok: imagens >= 3, peso: 20,
      dica: `Só ${imagens} foto(s). Anúncios com 5+ fotos convertem mais.` },
    { nome: 'Descrição completa (≥ 100 caracteres)', ok: len(descricao) >= 100, peso: 15,
      dica: 'Descrição curta ou vazia — detalhe benefícios, medidas e conteúdo da embalagem.' },
    { nome: 'Atributos/ficha preenchidos', ok: atributos >= 3, peso: 15,
      dica: `Só ${atributos} atributo(s). Preencha marca, material, cor etc. — melhora o ranqueamento e os filtros.` },
    { nome: 'Vídeo no anúncio', ok: temVideo, peso: 10,
      dica: 'Sem vídeo. Um vídeo curto aumenta a confiança e a conversão.' },
    { nome: 'SKU cadastrado', ok: len(sku) > 0, peso: 10,
      dica: 'Sem SKU — dificulta controle de estoque e conciliação.' },
    { nome: 'Variações ou estoque disponível', ok: temVariacao || estoque > 0, peso: 10,
      dica: 'Sem variação e sem estoque — anúncio não vende assim.' },
  ];

  const score = criterios.reduce((s, c) => s + (c.ok ? c.peso : 0), 0);
  const faltando = criterios.filter((c) => !c.ok);
  return {
    score,
    nivel: score >= 80 ? 'otimo' : score >= 60 ? 'bom' : score >= 40 ? 'regular' : 'ruim',
    criterios,
    faltando: faltando.map((c) => ({ nome: c.nome, dica: c.dica, peso: c.peso })),
    resumo: {
      titulo_chars: len(titulo), imagens, descricao_chars: len(descricao),
      atributos, video: temVideo, sku: len(sku) > 0, variacoes: temVariacao, estoque,
    },
  };
}

module.exports = { scoreItem };
