// Medidas da CAIXA (embalagem) declaradas no anúncio do ML: lê os atributos
// PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT do objeto do item (ou `shipping.dimensions`
// como fallback). Retorna { comprimento, largura, altura, peso, texto } ou null —
// só existe se o vendedor preencheu esses atributos. Compartilhado entre o worker
// (que cacheia em items.package_dims no sync) e quem precisar exibir.
// Ver .claude/embalagem.md.
function packageDimsFromItem(item) {
  if (!item) return null;
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const get = (id) => {
    const a = attrs.find((x) => x.id === id);
    if (!a) return null;
    if (a.value_struct && a.value_struct.number != null) return `${a.value_struct.number}${a.value_struct.unit ? ' ' + a.value_struct.unit : ''}`;
    return a.value_name || null;
  };
  const alt = get('PACKAGE_HEIGHT'), lar = get('PACKAGE_WIDTH'), comp = get('PACKAGE_LENGTH'), peso = get('PACKAGE_WEIGHT');
  let texto = null;
  if (comp || lar || alt) texto = [comp, lar, alt].filter(Boolean).join(' × ') + (peso ? ` · ${peso}` : '');
  else if (item.shipping && item.shipping.dimensions) texto = String(item.shipping.dimensions);
  return texto ? { comprimento: comp, largura: lar, altura: alt, peso, texto } : null;
}

module.exports = { packageDimsFromItem };
