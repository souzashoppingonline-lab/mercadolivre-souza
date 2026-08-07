// Embalagem — bipagem de etiqueta (FLEX/Mercado Envios) + conferência em
// vídeo. Módulo independente: só lê `orders`/`items` (leitura, nunca
// escreve nelas) e escreve/lê `packing_videos`. Ver .claude/embalagem.md.
//
// A extração do `shipping_id` a partir do que foi bipado (JSON do QR ou
// string crua do barcode linear) acontece no FRONTEND — esta rota já
// recebe o shipping_id limpo.
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const pool = require('../db/pool');
const env = require('../config/env');
const { getShopeeClientForStore } = require('../marketplaces/shopee/shopeeClient');
const { generateLabelPDF } = require('../thermal/pdfLabel');
const ml = require('../mlClient');

const router = express.Router();

const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'embalagem-videos');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(STORAGE_ROOT, day);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const shippingId = String(req.body.shipping_id || 'sem-id').replace(/[^a-zA-Z0-9_-]/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${shippingId}_${stamp}.webm`);
  },
});
// Limite generoso (300MB) — gravação de conferência dura tipicamente 1-3min,
// bem abaixo disso; o limite é só uma trava de segurança.
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

// Registra uma falha ao salvar o vídeo de embalagem (nunca lança — logar não
// pode virar um 2º erro). Tabela embalagem_errors (v65), lida pela aba "Erros".
async function logEmbalagemError({ error_type, shipping_id, order_ids, store_id, staff_user_name, detail, file_path }) {
  try {
    let nick = null;
    if (store_id) {
      const r = await pool.query(`SELECT nickname FROM stores WHERE id = $1`, [store_id]);
      nick = r.rows[0]?.nickname || null;
    }
    await pool.query(
      `INSERT INTO embalagem_errors (error_type, shipping_id, order_ids, store_id, store_nickname, staff_user_name, detail, file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [error_type || 'desconhecido', shipping_id || null,
       Array.isArray(order_ids) && order_ids.length ? order_ids.map(String) : null,
       store_id || null, nick, staff_user_name || null, String(detail || '').slice(0, 600), file_path || null]
    );
  } catch (e) { console.error('[embalagem] logEmbalagemError falhou:', e.message); }
}

// Wrap do multer: captura erro de upload/disco/limite (que o multer manda pro
// next) e registra no relatório antes de responder — sem isso, disco cheio ou
// vídeo grande virava um 500 genérico sem rastro.
function uploadVideo(req, res, next) {
  upload.single('video')(req, res, async (err) => {
    if (!err) return next();
    const tipo = err.code === 'LIMIT_FILE_SIZE' ? 'video_grande' : 'upload';
    await logEmbalagemError({
      error_type: tipo, shipping_id: req.body?.shipping_id,
      order_ids: (() => { try { return JSON.parse(req.body?.order_ids || '[]'); } catch { return []; } })(),
      store_id: req.body?.store_id, staff_user_name: req.body?.staff_user_name, detail: err.message,
    });
    res.status(500).json({ error: 'Falha ao receber o vídeo (' + tipo + '): ' + err.message + '. Registrado no Relatório de Erros.' });
  });
}

// Último vídeo gravado pra essa etiqueta (ML ou Shopee) — o packing_videos
// guarda o valor bipado (shipping_id do ML ou tracking da Shopee) na mesma
// coluna `shipping_id`, então a checagem é a mesma pros dois.
async function lastPacking(key, orderIds = []) {
  // Casa pelo valor bipado (shipping_id/tracking) OU pela sobreposição de
  // order_ids (`&&`) — assim avisa "já bipado" mesmo quando o pack foi gravado
  // por um código diferente do que está sendo bipado agora.
  const arr = Array.isArray(orderIds) && orderIds.length ? orderIds.map(String) : null;
  const { rows } = await pool.query(
    `SELECT id, created_at FROM packing_videos
      WHERE shipping_id = $1 OR ($2::text[] IS NOT NULL AND order_ids && $2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [key, arr]
  );
  return rows[0] || null;
}

// Casa a etiqueta Shopee (tracking BR...) com o pedido e expande o item_list do
// raw_data em "cards" no mesmo formato que o frontend já renderiza pro ML.
// Foto vem de item.image_info.image_url (a resposta de get_order_detail traz),
// então não depende da sincronização de catálogo. Comprador fica null (dado
// sensível — app sem acesso). Variação vira variation_attributes (model_name).
// Foto da variação vem do models JSONB em shopee_item_data (se houver).
async function lookupShopeeByTracking(tracking) {
  // Uma linha por pedido. NÃO fazer JOIN com shopee_item_data por store_id: isso
  // multiplicava o pedido pela quantidade de itens do catálogo da loja (ex.: 41
  // itens → 41 cópias do mesmo card). A foto de variação é buscada à parte, só
  // para os itens DESTE pedido (ver abaixo).
  const { rows } = await pool.query(
    `SELECT sod.order_sn, sod.raw_data, o.store_id, o.status, o.date_created, s.nickname AS store_nickname
       FROM shopee_order_data sod
       JOIN orders o ON o.ml_id = sod.order_sn
       LEFT JOIN stores s ON s.id = o.store_id
      WHERE sod.tracking_number = $1`,
    [tracking]
  );
  const out = [];
  for (const r of rows) {
    const raw = r.raw_data || {};
    const items = Array.isArray(raw.item_list) ? raw.item_list : [];
    // Foto de variação (model_id → imagem) do catálogo, buscada apenas para os
    // item_ids deste pedido — sem multiplicar linhas.
    const modelsMap = new Map();
    const itemIds = [...new Set(items.map((it) => (it.item_id != null ? String(it.item_id) : null)).filter(Boolean))];
    if (itemIds.length) {
      try {
        const { rows: sidRows } = await pool.query(
          `SELECT tier_variation FROM shopee_item_data WHERE store_id = $1 AND item_id = ANY($2::text[])`,
          [r.store_id, itemIds]
        );
        for (const sid of sidRows) {
          const tv = typeof sid.tier_variation === 'string' ? JSON.parse(sid.tier_variation) : sid.tier_variation;
          if (Array.isArray(tv?.[0]?.options)) {
            for (const opt of tv[0].options) {
              if (opt.picture?.image_url && opt.model_id) modelsMap.set(String(opt.model_id), opt.picture.image_url);
            }
          }
        }
      } catch (e) { /* sem foto de variação — cai na foto principal do item */ }
    }
    for (const it of items) {
      const mainImg = it.image_info && (it.image_info.image_url || (Array.isArray(it.image_info.image_url_list) && it.image_info.image_url_list[0]));
      // Tenta a foto da variação primeiro, fallback para a foto principal
      const variationImg = it.model_id ? modelsMap.get(String(it.model_id)) : null;
      const img = variationImg || mainImg;
      out.push({
        order_id: r.order_sn,
        item_id: it.item_id != null ? String(it.item_id) : null,
        title: it.item_name || '(sem título)',
        quantity: it.model_quantity_purchased || 1,
        buyer_nickname: null, // dado sensível — app Shopee sem acesso
        store_id: r.store_id,
        unit_price: it.model_discounted_price != null ? it.model_discounted_price : it.model_original_price,
        status: r.status,
        shipping_type: 'shopee',
        date_created: r.date_created,
        seller_sku: it.model_sku || it.item_sku || null,
        // mesmo shape que o ML: array de {name, value_name} — a variação Shopee é o model_name.
        variation_attributes: it.model_name ? [{ name: 'Variação', value_name: it.model_name }] : null,
        thumbnail: img || null,
        permalink: null,
        available_quantity: null,
        store_nickname: r.store_nickname,
        marketplace: 'SHOPEE',
      });
    }
  }
  return out;
}

// Busca sob demanda: quando o bipe não acha o rastreio Shopee no banco (pedido
// recém-preparado, antes da sincronização de 15 min pegá-lo), puxa o
// tracking_number na hora dos pedidos Shopee recentes que ainda estão sem — até
// achar o código bipado. Ordena por mais recente (o recém-preparado vem 1º) e
// PARA assim que casa, pra não estourar latência nem rate limit da Shopee.
// Retorna true se preencheu o rastreio bipado. Escreve só em shopee_order_data.
async function refreshShopeeTrackingOnDemand(tracking) {
  const { rows } = await pool.query(
    `SELECT sod.order_sn, o.store_id
       FROM shopee_order_data sod
       JOIN orders o ON o.ml_id = sod.order_sn
      WHERE sod.tracking_number IS NULL
        AND o.date_created > now() - interval '20 days'
      ORDER BY o.date_created DESC
      LIMIT 40`
  );
  if (!rows.length) return false;
  const clients = new Map(); // store_id → client (ou null se falhou construir)
  let found = false;
  for (const r of rows) {
    if (!clients.has(r.store_id)) {
      try { clients.set(r.store_id, await getShopeeClientForStore(pool, r.store_id, env.shopee)); }
      catch (e) { clients.set(r.store_id, null); }
    }
    const client = clients.get(r.store_id);
    if (!client) continue;
    try {
      const tn = await client.getTrackingNumber(r.order_sn);
      if (tn) {
        await pool.query(
          `UPDATE shopee_order_data SET tracking_number = $1, updated_at = now() WHERE order_sn = $2`,
          [tn, r.order_sn]
        );
        if (tn === tracking) { found = true; break; } // achou o bipado — para aqui
      }
    } catch (e) { /* ignora e tenta o próximo pedido */ }
  }
  return found;
}

// Helper para extrair foto da variação de um pedido ML — se houver variation_name
// ordenada, procura essa variação no item.variations[] e pega sua picture.
// Versão melhorada: tenta múltiplas estratégias de matching.
function extractVariationPicture(orderData) {
  try {
    const item0 = orderData?.order_items?.[0]?.item;
    if (!item0) return null;

    const variations = Array.isArray(item0.variations) ? item0.variations : [];

    // Estratégia 1: procura por variation_attributes (estrutura API atual)
    const varAttrs = orderData.order_items[0]?.item?.variation_attributes;
    if (Array.isArray(varAttrs) && varAttrs.length > 0 && variations.length > 0) {
      // Se há múltiplas variation_attributes, busca por todas (ex: Cor + Tamanho)
      for (const attr of varAttrs) {
        const searchValue = attr?.value_name;
        if (!searchValue) continue;

        // Busca exata: name ou model_name iguais a value_name
        let found = variations.find(v => {
          const varName = v.name || v.model_name;
          return varName?.toLowerCase?.() === searchValue.toLowerCase?.();
        });

        // Se não achou exata, tenta por attribute_combinations
        if (!found) {
          found = variations.find(v =>
            v.attribute_combinations?.some(ac =>
              ac.values?.some(val => val?.toLowerCase?.() === searchValue.toLowerCase?.())
            )
          );
        }

        // Se encontrou e tem picture, retorna
        if (found?.picture?.url) return found.picture.url;
        if (found?.pictures?.[0]?.url) return found.pictures[0].url;
      }
    }

    // Estratégia 2: se só há 1 variação, é a que foi comprada
    if (variations.length === 1) {
      const v = variations[0];
      if (v?.picture?.url) return v.picture.url;
      if (v?.pictures?.[0]?.url) return v.pictures[0].url;
    }

    // Estratégia 3: tenta com item.thumbnail (foto genérica do item)
    if (item0.thumbnail) return item0.thumbnail;
    if (item0.picture?.url) return item0.picture.url;
    if (item0.pictures?.[0]?.url) return item0.pictures[0].url;

    // Estratégia 4: Última alternativa — primeira variação qualquer
    // (nem sempre a correta, mas é melhor que nada)
    if (variations.length > 0) {
      const firstVar = variations[0];
      if (firstVar?.picture?.url) return firstVar.picture.url;
      if (firstVar?.pictures?.[0]?.url) return firstVar.pictures[0].url;
    }

  } catch (e) { console.error('[embalagem] erro ao extrair foto de variação:', e.message); }
  return null;
}

// DEBUG: endpoint temporário pra diagnosticar estrutura de variações (sem autenticação)
router.get('/debug/pedido/:shippingId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.ml_id, o.title, o.raw_data FROM orders o WHERE o.shipping_id = $1 LIMIT 1`,
      [req.params.shippingId]
    );
    if (!rows.length) return res.status(404).json({ error: 'pedido não encontrado' });

    const row = rows[0];
    const item = row.raw_data?.order_items?.[0]?.item || {};
    const variations = item.variations || [];

    res.json({
      title: row.title,
      has_variations: variations.length > 0,
      num_variations: variations.length,
      variation_attributes: row.raw_data?.order_items?.[0]?.item?.variation_attributes,
      first_variation_structure: variations[0] ? {
        id: variations[0].id,
        name: variations[0].name,
        model_name: variations[0].model_name,
        has_picture: !!variations[0].picture,
        has_pictures: Array.isArray(variations[0].pictures) && variations[0].pictures.length > 0,
        picture: variations[0].picture?.url ? 'URL_EXISTS' : null,
        pictures_count: variations[0].pictures?.length || 0
      } : null,
      all_variations_summary: variations.map((v, i) => ({
        index: i,
        name: v.name || v.model_name,
        has_picture: !!v.picture?.url,
        has_pictures: Array.isArray(v.pictures) && v.pictures.length > 0
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-resolver ML sob demanda: quando o bipe (numérico = shipment id do ML)
// não acha nenhum pedido por shipping_id no banco — pedido recém-criado, ou o
// webhook chegou antes do envio existir e ninguém reprocessou — consulta a API
// do ML pra achar o pedido e gravá-lo com o shipping_id, self-heal. Espelha a
// auto-busca que a Shopee já tem. Ver .claude/embalagem.md.
async function resolveMlByShipment(code) {
  const shipId = String(code).replace(/\D/g, '');
  if (!shipId) return false;
  const { rows: lojas } = await pool.query(
    `SELECT id FROM stores
      WHERE (marketplace_id = (SELECT id FROM marketplaces WHERE code='ML') OR marketplace_id IS NULL)
        AND access_token IS NOT NULL`
  );
  for (const loja of lojas) {
    let ship;
    try { ship = await ml.getShipment(shipId, loja.id); }
    catch (_) { continue; } // 403/404 = não é dessa loja, tenta a próxima
    const orderId = ship && (ship.order_id || ship.order?.id);
    if (!orderId) continue;
    let order;
    try { order = await ml.getOrder(orderId, loja.id); }
    catch (_) { continue; }
    if (!order || !order.id) continue;
    const it0 = (order.order_items && order.order_items[0]) || {};
    // Logística: o objeto de shipment (já buscado) é a fonte mais confiável do
    // tipo — `order.shipping.logistic_type` às vezes vem vazio em venda recém-
    // criada, o que deixava a tela mostrando "Desconhecido". Tenta shipment
    // primeiro (logistic_type / logistic.type / mode), depois o pedido.
    const logisticType = ship.logistic_type || ship.logistic?.type || ship.mode
      || order.shipping?.logistic_type || '';
    await pool.query(
      `INSERT INTO orders (ml_id, store_id, buyer_nickname, item_id, title, total_amount, quantity, unit_price,
                           shipping_type, status, date_created, raw_data, shipping_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (ml_id) DO UPDATE SET
         shipping_id = COALESCE(EXCLUDED.shipping_id, orders.shipping_id),
         raw_data = EXCLUDED.raw_data, status = EXCLUDED.status,
         shipping_type = COALESCE(NULLIF(EXCLUDED.shipping_type,''), orders.shipping_type),
         updated_at = now()`,
      [
        String(order.id), loja.id, order.buyer?.nickname || null,
        it0.item?.id || null, it0.item?.title || order.title || null,
        order.total_amount ?? null, it0.quantity ?? 1, it0.unit_price ?? null,
        logisticType, order.status || null,
        order.date_created || null, JSON.stringify(order), String(ship.id || shipId),
      ]
    );
    return true;
  }
  return false;
}

// GET /api/embalagem/pedido/:shippingId — busca pedido(s) pela etiqueta bipada.
// Pode retornar mais de 1 linha: um mesmo envio (pack) pode agrupar vários
// pedidos do mesmo comprador.
router.get('/pedido/:shippingId', async (req, res) => {
  try {
    const mlQuery = () => pool.query(
      `SELECT o.ml_id AS order_id, o.item_id, o.title, o.quantity, o.buyer_nickname, o.store_id,
              o.unit_price, o.status, o.shipping_type, o.date_created,
              o.raw_data->'order_items'->0->'item'->>'seller_sku' AS seller_sku,
              o.raw_data->'order_items'->0->'item'->'variation_attributes' AS variation_attributes,
              i.thumbnail, i.permalink, i.available_quantity, i.package_dims AS dimensoes,
              s.nickname AS store_nickname, o.raw_data
       FROM orders o
       LEFT JOIN items i ON i.ml_id = o.item_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.shipping_id = $1
       ORDER BY o.date_created ASC`,
      [req.params.shippingId]
    );

    let { rows } = await mlQuery();

    // Não achou no banco e é numérico (candidato a shipment ML): resolve na API
    // do ML e grava o pedido, depois consulta de novo (self-heal).
    if (!rows.length && /^\d+$/.test(String(req.params.shippingId).trim())) {
      try {
        if (await resolveMlByShipment(req.params.shippingId)) ({ rows } = await mlQuery());
      } catch (e) {
        console.error('[api/embalagem] auto-resolver ML falhou:', e.message);
      }
    }

    // Enriquece cada pedido com a foto de variação (se houver)
    if (rows.length) {
      rows.forEach(row => {
        const rawData = row.raw_data || {};
        const variationPicture = extractVariationPicture(rawData);
        // DEBUG: log temporário pra entender a estrutura
        if (!variationPicture && process.env.DEBUG_EMBALAGEM) {
          console.log('[embalagem] variation_picture não encontrada para', {
            title: row.title,
            variation_attributes: row.variation_attributes,
            variations_count: rawData?.order_items?.[0]?.item?.variations?.length || 0,
            item_picture: rawData?.order_items?.[0]?.item?.picture?.url,
            first_variation: rawData?.order_items?.[0]?.item?.variations?.[0]?.picture?.url
          });
        }
        // Prioriza a foto da variação; fallback para thumbnail principal
        row.thumbnail = variationPicture || row.thumbnail;
      });
      // As medidas da caixa (row.dimensoes) já vêm do banco (items.package_dims,
      // preenchido pelo worker no sync) — sem GET no ML aqui, imune a rate limit.
      const already = await lastPacking(req.params.shippingId, rows.map(r => r.order_id));
      return res.json({ shipping_id: req.params.shippingId, marketplace: 'ML', orders: rows, already_packed: already });
    }

    // Fallback Shopee: a etiqueta Shopee traz o RASTREIO (BR...) no QR, não o
    // número do pedido. Se não achou por shipping_id (ML), tenta casar por
    // tracking_number (Shopee) — mesma estação de bipagem pros dois marketplaces.
    const codigo = String(req.params.shippingId).trim();
    let shopeeOrders = await lookupShopeeByTracking(codigo);
    // Auto-busca sob demanda: se não achou e o código NÃO é um shipping_id ML
    // (numérico puro), é candidato a rastreio Shopee ainda não sincronizado —
    // puxa o tracking na hora e tenta de novo, sem o operador fazer nada.
    if (!shopeeOrders.length && !/^\d+$/.test(codigo)) {
      try {
        const achou = await refreshShopeeTrackingOnDemand(codigo);
        if (achou) shopeeOrders = await lookupShopeeByTracking(codigo);
      } catch (e) {
        console.error('[api/embalagem] auto-busca rastreio Shopee falhou:', e.message);
      }
    }
    if (shopeeOrders.length) {
      const already = await lastPacking(codigo, shopeeOrders.map(o => o.order_id));
      return res.json({ shipping_id: codigo, marketplace: 'SHOPEE', orders: shopeeOrders, already_packed: already });
    }
    return res.status(404).json({ error: 'Nenhum pedido encontrado para essa etiqueta' });
  } catch (e) {
    console.error('[api/embalagem] GET /pedido/:shippingId', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/embalagem/finalizar — recebe o vídeo gravado (multipart) e
// grava o registro. Campos de texto devem vir ANTES do arquivo no
// FormData, pra o multer já ter req.body.shipping_id disponível quando
// monta o nome/pasta do arquivo (destination/filename acima).
router.post('/finalizar', uploadVideo, async (req, res) => {
  const { shipping_id, order_ids, duration_seconds, store_id, staff_user_id, staff_user_name } = req.body;
  let orderIdsArr = [];
  try { orderIdsArr = JSON.parse(order_ids || '[]'); } catch (e) { orderIdsArr = []; }
  try {
    if (!req.file) {
      await logEmbalagemError({ error_type: 'arquivo_ausente', shipping_id, order_ids: orderIdsArr, store_id, staff_user_name, detail: 'req.file ausente (gravação não chegou ao servidor)' });
      return res.status(400).json({ error: 'Arquivo de vídeo ausente — registrado no Relatório de Erros.' });
    }
    if (!shipping_id) {
      await logEmbalagemError({ error_type: 'sem_shipping_id', order_ids: orderIdsArr, store_id, staff_user_name, detail: 'shipping_id ausente no envio', file_path: req.file.path });
      return res.status(400).json({ error: 'shipping_id é obrigatório — registrado no Relatório de Erros.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO packing_videos (shipping_id, order_ids, file_path, duration_seconds, store_id, staff_user_id, staff_user_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [shipping_id, orderIdsArr, req.file.path, duration_seconds ? Number(duration_seconds) : null, store_id || null, staff_user_id || null, staff_user_name || null]
    );
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('[api/embalagem] POST /finalizar', e.message);
    // O arquivo em disco é a gravação real — NÃO apaga; loga o caminho pra
    // recuperação manual e registra o erro no relatório.
    await logEmbalagemError({ error_type: 'db_insert', shipping_id, order_ids: orderIdsArr, store_id, staff_user_name, detail: e.message, file_path: req.file?.path });
    res.status(500).json({ error: 'Não foi possível salvar o registro do vídeo. O erro foi registrado no Relatório de Erros. Detalhe: ' + e.message });
  }
});

// GET /api/embalagem/erros?days — relatório de erros de embalagem (v65).
router.get('/erros', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const { rows } = await pool.query(
      `SELECT id, error_type, shipping_id, order_ids, store_id, store_nickname, staff_user_name, detail, file_path, created_at
         FROM embalagem_errors
        WHERE created_at >= now() - ($1::int * interval '1 day')
        ORDER BY created_at DESC LIMIT 500`,
      [days]
    );
    res.json({ errors: rows });
  } catch (e) {
    console.error('[api/embalagem] GET /erros', e.message);
    res.status(500).json({ error: e.message, errors: [] });
  }
});

// Classificação de logística do ML (mesma de logLabel do frontend).
function mlLogLabel(tipo) {
  const l = (tipo || '').toLowerCase();
  if (l.includes('self_service') || l.includes('flex')) return 'Flex';
  if (l.includes('xd_drop_off') || l.includes('me1') || l.includes('me2') || l.includes('cross_docking')) return 'Mercado Envios';
  if (l.includes('fulfillment')) return 'Full';
  return tipo || '—';
}

// GET /api/embalagem/auditoria?only_printed&only_missing — "Expedição do dia":
// lista os pedidos que PRECISAM SAIR (base no STATUS de envio, não na data —
// decisão do usuário) e cruza com packing_videos pra dizer o que já foi bipado
// e o que falta. ML: FLEX/Mercado Envios com shipping_status='ready_to_ship'
// (substatus 'printed' = etiqueta impressa). Shopee: Entrega Rápida/Agência com
// order_status READY_TO_SHIP/PROCESSED. Ver .claude/embalagem.md.
router.get('/auditoria', async (req, res) => {
  try {
    const onlyPrinted = req.query.only_printed === '1' || req.query.only_printed === 'true';
    const onlyMissing = req.query.only_missing === '1' || req.query.only_missing === 'true';
    const search = (req.query.search || '').trim();
    const params = [];
    let filterBlock;
    if (search) {
      // Busca direta por pedido / shipping_id / rastreio: ignora status,
      // logística e período — só quer saber se AQUELE pedido foi bipado.
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      filterBlock = `AND (o.ml_id ILIKE ${p} OR o.shipping_id ILIKE ${p} OR sod.tracking_number ILIKE ${p})`;
    } else {
      // Filtro de período pela DATA DA VENDA (date_created, em SP). Aceita
      // date_from/date_to (personalizado) OU days (últimos N dias). Sem nada = tudo.
      let dateCond = '';
      const dFrom = req.query.date_from, dTo = req.query.date_to;
      const days = Number(req.query.days);
      if (dFrom || dTo) {
        if (dFrom) { params.push(dFrom); dateCond += ` AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`; }
        if (dTo)   { params.push(dTo);   dateCond += ` AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`; }
      } else if (Number.isFinite(days) && days > 0) {
        params.push(Math.min(days, 365));
        dateCond = ` AND (o.date_created AT TIME ZONE 'America/Sao_Paulo')::date > (current_date - $${params.length}::int)`;
      }
      filterBlock =
        `AND (
           (COALESCE(mk.code,'ML') = 'ML'
             AND lower(COALESCE(o.shipping_type,'')) ~ 'self_service|flex|xd_drop_off|me1|me2|cross_docking'
             AND o.shipping_status = 'ready_to_ship')
           OR
           (mk.code = 'SHOPEE'
             AND COALESCE(sod.order_status,'') IN ('READY_TO_SHIP','PROCESSED'))
         )${dateCond}`;
    }
    const { rows } = await pool.query(
      `SELECT o.ml_id AS order_id, o.title, o.quantity, o.buyer_nickname, o.store_id,
              o.shipping_type, o.shipping_status, o.shipping_substatus, o.shipping_id,
              o.date_created, o.date_ready_to_ship,
              COALESCE(mk.code,'ML') AS marketplace,
              s.nickname AS store_nickname,
              sod.tracking_number AS shopee_tracking,
              sod.order_status AS shopee_status,
              sod.raw_data->>'shipping_carrier' AS shopee_carrier,
              pj.printed_at AS etiqueta_impressa_at,
              pvv.created_at AS bipado_at,
              (pvv.created_at IS NOT NULL) AS bipado
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       LEFT JOIN marketplaces mk ON mk.id = s.marketplace_id
       LEFT JOIN shopee_order_data sod ON sod.order_sn = o.ml_id
       LEFT JOIN LATERAL (
         SELECT pj.printed_at FROM print_jobs pj
         WHERE pj.printed_at IS NOT NULL
           AND (pj.shipping_id = o.shipping_id OR pj.shipping_id = sod.tracking_number)
         ORDER BY pj.printed_at DESC LIMIT 1
       ) pj ON true
       LEFT JOIN LATERAL (
         SELECT pv.created_at FROM packing_videos pv
         WHERE o.ml_id = ANY(pv.order_ids)
            OR (o.shipping_id IS NOT NULL AND pv.shipping_id = o.shipping_id)
            OR (sod.tracking_number IS NOT NULL AND pv.shipping_id = sod.tracking_number)
         ORDER BY pv.created_at DESC LIMIT 1
       ) pvv ON true
       WHERE o.status <> 'cancelled'
         ${filterBlock}
       ORDER BY bipado ASC, COALESCE(o.date_ready_to_ship, o.date_created) ASC
       LIMIT 1000`,
      params
    );
    const items = rows.map(r => {
      const isML = r.marketplace === 'ML';
      let logistica, printed;
      if (isML) {
        logistica = mlLogLabel(r.shipping_type);
        printed = r.shipping_substatus === 'printed';
      } else {
        const c = (r.shopee_carrier || '').toLowerCase();
        logistica = (c.includes('rápid') || c.includes('rapid')) ? 'Entrega Rápida'
                  : (c.includes('agênc') || c.includes('agenc')) ? 'Agência'
                  : (r.shopee_carrier || 'Shopee');
        printed = r.shopee_status === 'PROCESSED';
      }
      return { ...r, logistica, printed };
    }).filter(r => (!onlyPrinted || r.printed) && (!onlyMissing || !r.bipado));
    const total = items.length;
    const bipados = items.filter(r => r.bipado).length;
    // Quebra por logística (pra o card de resumo)
    const porLog = {};
    for (const r of items) {
      porLog[r.logistica] = porLog[r.logistica] || { total: 0, bipados: 0 };
      porLog[r.logistica].total++;
      if (r.bipado) porLog[r.logistica].bipados++;
    }
    res.json({ items, resumo: { total, bipados, faltando: total - bipados, por_logistica: porLog } });
  } catch (e) {
    console.error('[api/embalagem] GET /auditoria', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// GET /api/embalagem/videos?order_id&buyer&date_from&date_to — consulta
// (usado tanto na aba "Buscar vídeos" quanto, no futuro, num botão em
// pages/devolucoes.html).
router.get('/videos', async (req, res) => {
  try {
    const { order_id, buyer, date_from, date_to, store_id, marketplace } = req.query;
    const where = [];
    const params = [];
    // Casa pelo RASTREIO/etiqueta (pv.shipping_id — o valor bipado: tracking BR...
    // da Shopee ou shipping_id do ML) OU pelo número do pedido (pv.order_ids).
    if (order_id) { params.push(order_id); where.push(`(pv.shipping_id = $${params.length} OR $${params.length} = ANY(pv.order_ids))`); }
    if (store_id) { params.push(store_id); where.push(`pv.store_id = $${params.length}`); }
    if (marketplace) { params.push(marketplace); where.push(`mk.code = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`pv.created_at >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`pv.created_at <= $${params.length}`); }
    if (buyer) { params.push(`%${buyer}%`); where.push(`ord.buyer_nickname ILIKE $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Marketplace de cada vídeo = marketplace da loja dona (stores.marketplace_id).
    const { rows } = await pool.query(
      `SELECT pv.id, pv.shipping_id, pv.order_ids, pv.created_at, pv.duration_seconds, pv.store_id,
              ord.title AS sample_title, ord.buyer_nickname AS sample_buyer, ord.shipping_type AS sample_shipping_type,
              s.nickname AS store_nickname, COALESCE(mk.code, 'ML') AS marketplace
       FROM packing_videos pv
       LEFT JOIN LATERAL (
         SELECT title, buyer_nickname, shipping_type FROM orders WHERE ml_id = pv.order_ids[1]
       ) ord ON true
       LEFT JOIN stores s ON s.id = pv.store_id
       LEFT JOIN marketplaces mk ON mk.id = s.marketplace_id
       ${whereSql}
       ORDER BY pv.created_at DESC
       LIMIT 100`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/embalagem] GET /videos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/videos-por-pedidos?order_ids=1,2,3 — lookup em lote
// (usado por pages/devolucoes.html pra saber, sem N+1, quais pedidos de uma
// lista têm vídeo de embalagem gravado, e mostrar um botão "Assistir" direto
// na tela de devoluções). Devolve só os que têm vídeo — {order_id: {id, created_at}}.
// Quando um shipping_id agrupa mais de um vídeo (bipado 2x), fica o mais recente.
router.get('/videos-por-pedidos', async (req, res) => {
  try {
    const orderIds = String(req.query.order_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!orderIds.length) return res.json({});

    const { rows } = await pool.query(
      `SELECT id, order_ids, created_at
       FROM packing_videos
       WHERE order_ids && $1::text[]
       ORDER BY created_at DESC`,
      [orderIds]
    );

    const map = {};
    for (const row of rows) {
      for (const oid of row.order_ids) {
        if (orderIds.includes(oid) && !map[oid]) map[oid] = { id: row.id, created_at: row.created_at };
      }
    }
    res.json(map);
  } catch (e) {
    console.error('[api/embalagem] GET /videos-por-pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/por-hora?date=YYYY-MM-DD&store_id= — quantidade de
// bipagens por hora (0-23) num dia, sempre 24 posições (zero-fill) pra dar
// pra montar um gráfico de colunas comparando dois dias sem buraco no eixo.
// Mesmo padrão de fuso já usado no resto do sistema pra colunas TIMESTAMPTZ
// (AT TIME ZONE 'America/Sao_Paulo' antes de truncar — ver decisions.md).
router.get('/por-hora', async (req, res) => {
  try {
    const { date, store_id, marketplace } = req.query;
    if (!date) return res.status(400).json({ error: 'date é obrigatório (YYYY-MM-DD)' });

    const { rows } = await pool.query(
      `SELECT h.hour, COALESCE(a.qty, 0)::int AS qty
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN (
         SELECT EXTRACT(HOUR FROM pv.created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
                COUNT(*)::int AS qty
         FROM packing_videos pv
         WHERE (pv.created_at AT TIME ZONE 'America/Sao_Paulo')::date = $1::date
           AND ($2::bigint IS NULL OR pv.store_id = $2)
           AND ($3 = '' OR pv.store_id IN (
                 SELECT st.id FROM stores st LEFT JOIN marketplaces mk ON mk.id = st.marketplace_id
                 WHERE COALESCE(mk.code,'ML') = $3))
         GROUP BY 1
       ) a ON a.hour = h.hour
       ORDER BY h.hour`,
      [date, store_id || null, marketplace || '']
    );
    res.json({ date, hours: rows });
  } catch (e) {
    console.error('[api/embalagem] GET /por-hora', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/historico?days=30&store_id= — série diária (zero-fill)
// pra enxergar tendência de produtividade ao longo do tempo, não só "hoje
// vs. ontem" (ver /por-hora acima). duration_sum/duration_orders (em vez de
// já devolver uma média pronta) seguem o mesmo padrão SUM/SUM do card
// "Tempo médio / pedido" da Conferência do Dia — soma total, não média das
// médias, calculado no frontend a partir desses dois números.
router.get('/historico', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const { store_id, marketplace } = req.query;

    // Bucketing por DATA LOCAL (America/Sao_Paulo): agrega os vídeos por dia
    // convertendo created_at (timestamptz) pra data SP, depois zero-fill via
    // generate_series de N dias. Substitui o LEFT JOIN por faixa de timestamp
    // (dava 0 no gráfico mesmo com bipagens no dia). `date` volta como texto
    // 'YYYY-MM-DD' pro frontend.
    const { rows } = await pool.query(
      `WITH agg AS (
         SELECT (pv.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS d,
                COUNT(*)::int AS count,
                COALESCE(SUM(pv.duration_seconds) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::numeric AS duration_sum,
                COALESCE(SUM(cardinality(pv.order_ids)) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::int AS duration_orders
         FROM packing_videos pv
         WHERE (pv.created_at AT TIME ZONE 'America/Sao_Paulo')::date > (current_date - $1::int)
           AND ($2::bigint IS NULL OR pv.store_id = $2)
           AND ($3 = '' OR pv.store_id IN (
                 SELECT st.id FROM stores st LEFT JOIN marketplaces mk ON mk.id = st.marketplace_id
                 WHERE COALESCE(mk.code,'ML') = $3))
         GROUP BY 1
       )
       SELECT to_char(current_date - g.n, 'YYYY-MM-DD') AS date,
              COALESCE(a.count, 0)::int AS count,
              COALESCE(a.duration_sum, 0)::numeric AS duration_sum,
              COALESCE(a.duration_orders, 0)::int AS duration_orders
       FROM generate_series(0, $1::int - 1) AS g(n)
       LEFT JOIN agg a ON a.d = (current_date - g.n)
       ORDER BY 1`,
      [days, store_id || null, marketplace || '']
    );
    res.json({ days: rows });
  } catch (e) {
    console.error('[api/embalagem] GET /historico', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/videos/:id/file — stream do arquivo. res.sendFile já
// suporta Range requests nativamente (necessário pra dar play/scrub no
// player HTML5 sem baixar o vídeo inteiro de uma vez).
router.get('/videos/:id/file', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT file_path FROM packing_videos WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'vídeo não encontrado' });
    res.sendFile(path.resolve(rows[0].file_path), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'arquivo de vídeo não encontrado no disco' });
    });
  } catch (e) {
    console.error('[api/embalagem] GET /videos/:id/file', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/embalagem/relatorio?date_from&date_to&staff_user_name&marketplace
// — agregação por embalador (staff_user_name) e marketplace (código do marketplace).
// Devolve lista de {staff_user_name, marketplace, count} — estatísticas de embalagem.
router.get('/relatorio', async (req, res) => {
  try {
    const { date_from, date_to, staff_user_name, marketplace } = req.query;
    const where = [];
    const params = [];

    if (date_from) { params.push(date_from); where.push(`pv.created_at >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`pv.created_at <= $${params.length}`); }
    if (staff_user_name) { params.push(staff_user_name); where.push(`pv.staff_user_name = $${params.length}`); }

    let mkWhere = '';
    if (marketplace) {
      params.push(marketplace);
      mkWhere = `AND COALESCE(mk.code,'ML') = $${params.length}`;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT pv.staff_user_name,
              COALESCE(mk.code, 'ML') AS marketplace,
              COUNT(pv.id)::int AS count,
              COALESCE(SUM(pv.duration_seconds) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::numeric AS total_duration,
              COALESCE(SUM(cardinality(pv.order_ids)) FILTER (WHERE pv.duration_seconds IS NOT NULL), 0)::int AS total_orders
       FROM packing_videos pv
       LEFT JOIN stores s ON s.id = pv.store_id
       LEFT JOIN marketplaces mk ON mk.id = s.marketplace_id
       ${whereSql}
       ${mkWhere}
       GROUP BY pv.staff_user_name, COALESCE(mk.code, 'ML')
       ORDER BY pv.staff_user_name ASC, COALESCE(mk.code, 'ML') ASC`,
      params
    );
    res.json({ rows });
  } catch (e) {
    console.error('[api/embalagem] GET /relatorio', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/embalagem/print-label — imprime rótulo térmico (10x15 cm) com QR code
// Chamada após video finalizar com sucesso. Se impressora não está configurada, retorna ok=false.
router.post('/print-label', async (req, res) => {
  try {
    const { shipping_id, product_name, variation_type, sku, store_name, company_name } = req.body;
    if (!shipping_id) return res.status(400).json({ error: 'shipping_id é obrigatório' });

    console.log('[api/embalagem] POST /print-label → gerando PDF:', shipping_id);

    const pdfBuffer = await generateLabelPDF({
      shipping_id,
      product_name: product_name || '(sem título)',
      variation_type,
      sku,
      store_name: store_name || '(sem loja)',
      company_name: company_name || 'EMPRESA XYZ',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiqueta-${shipping_id}.pdf"`);
    res.send(pdfBuffer);
    console.log('[api/embalagem] ✓ PDF enviado:', shipping_id);
  } catch (e) {
    console.error('[api/embalagem] POST /print-label erro:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
