// Análise de Produtos — gravação de anúncio concorrente (compartilhado entre a
// rota de adição manual do dashboard e a rota da extensão). Ver .claude/analise-produtos.md.
const pool = require('../db/pool');

const num = (v) => (v === '' || v == null ? null : Number(v));
const bool = (v) => (v === true || v === 'true' || v === 1 || v === '1') ? true
                  : (v === false || v === 'false' || v === 0 || v === '0') ? false : null;

// Normaliza a linha do banco pro contrato do frontend (is_full/is_flex → full/flex).
function mapAd(r) {
  return {
    id: r.id, product_id: r.product_id, ml_id: r.ml_id, titulo: r.titulo,
    preco: r.preco, preco_original: r.preco_original, nota: r.nota, vendas: r.vendas,
    perguntas: r.perguntas, comentarios: r.comentarios, vendedor: r.vendedor,
    cidade: r.cidade, estado: r.estado, reputacao: r.reputacao,
    full: r.is_full, flex: r.is_flex, fotos: r.fotos, videos: r.videos,
    observacoes: r.observacoes, comentarios_texto: r.comentarios_texto,
    comentarios_auto: r.comentarios_auto, created_at: r.created_at,
  };
}

// Campos "achatados" do anúncio a partir do body (aceita foto única ou fotos[]).
function adValues(b) {
  b = b || {};
  const fotos = b.foto ? [b.foto] : (Array.isArray(b.fotos) ? b.fotos.filter(Boolean) : null);
  const videos = Array.isArray(b.videos) ? b.videos.filter(Boolean) : null;
  return {
    titulo: b.titulo || null, preco: num(b.preco), preco_original: num(b.preco_original),
    nota: num(b.nota), vendas: b.vendas || null, perguntas: num(b.perguntas), comentarios: num(b.comentarios),
    vendedor: b.vendedor || null, cidade: b.cidade || null, estado: b.estado || null,
    reputacao: b.reputacao || null, is_full: bool(b.full), is_flex: bool(b.flex),
    fotos: fotos && fotos.length ? JSON.stringify(fotos) : null,
    videos: videos && videos.length ? JSON.stringify(videos) : null,
    observacoes: b.observacoes || null, comentarios_texto: b.comentarios_texto || null,
    comentarios_auto: b.comentarios_auto || null,
  };
}

// Insere (manual, sem ml_id) ou faz upsert (extensão, com ml_id — recoleta atualiza).
// COALESCE preserva foto/observação já existentes se a recoleta vier vazia.
async function upsertAd(productId, b) {
  b = b || {};
  const v = adValues(b);
  const raw = b.raw != null ? (typeof b.raw === 'string' ? b.raw : JSON.stringify(b.raw)) : null;
  const cols = 'product_id, ml_id, titulo, preco, preco_original, nota, vendas, perguntas, comentarios, vendedor, cidade, estado, reputacao, is_full, is_flex, fotos, videos, observacoes, comentarios_texto, comentarios_auto, raw';
  const vals = [productId, b.ml_id || null, v.titulo, v.preco, v.preco_original, v.nota, v.vendas, v.perguntas,
                v.comentarios, v.vendedor, v.cidade, v.estado, v.reputacao, v.is_full, v.is_flex, v.fotos, v.videos, v.observacoes, v.comentarios_texto, v.comentarios_auto, raw];
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  let sql = `INSERT INTO analise_product_ads (${cols}) VALUES (${ph})`;
  if (b.ml_id) {
    sql += ` ON CONFLICT (product_id, ml_id) DO UPDATE SET
               titulo=EXCLUDED.titulo, preco=EXCLUDED.preco, preco_original=EXCLUDED.preco_original,
               nota=EXCLUDED.nota, vendas=EXCLUDED.vendas, perguntas=EXCLUDED.perguntas,
               comentarios=EXCLUDED.comentarios, vendedor=EXCLUDED.vendedor, cidade=COALESCE(EXCLUDED.cidade, analise_product_ads.cidade),
               estado=COALESCE(EXCLUDED.estado, analise_product_ads.estado), reputacao=COALESCE(EXCLUDED.reputacao, analise_product_ads.reputacao),
               is_full=COALESCE(EXCLUDED.is_full, analise_product_ads.is_full), is_flex=COALESCE(EXCLUDED.is_flex, analise_product_ads.is_flex),
               fotos=COALESCE(EXCLUDED.fotos, analise_product_ads.fotos), videos=COALESCE(EXCLUDED.videos, analise_product_ads.videos),
               observacoes=COALESCE(EXCLUDED.observacoes, analise_product_ads.observacoes),
               comentarios_texto=COALESCE(EXCLUDED.comentarios_texto, analise_product_ads.comentarios_texto),
               comentarios_auto=COALESCE(EXCLUDED.comentarios_auto, analise_product_ads.comentarios_auto),
               raw=COALESCE(EXCLUDED.raw, analise_product_ads.raw)`;
  }
  sql += ' RETURNING *';
  const { rows } = await pool.query(sql, vals);
  return mapAd(rows[0]);
}

module.exports = { num, bool, mapAd, adValues, upsertAd };
