// Rankeamento de anúncios novos — módulo central. Um anúncio marcado "em
// rankeamento" (ranking_ads) tem CADA venda e CADA alteração registrada em
// ranking_events e notificada na tela (WebSocket) + Telegram (tg_rankeamento).
// A cada N vendas (milestone_every, default 5) dispara um marco com resumo de
// ritmo. Ver .claude/rankeamento.md.
//
// Reaproveita notify.js (tgNotify) e ws/hub.js (publish) — as mesmas usadas
// pelo pipeline ML — então worker.js só chama onSale/onItemChange e não duplica
// lógica de Telegram/WS. mlClient é usado só no snapshot (visitas), nunca no bipe.
const pool = require('./db/pool');
const { tgNotify, tgNotifyForce } = require('./notify');
const { publish } = require('./ws/hub');

const BRL = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const fmtDT = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const linkOf = (mlId) => `https://www.mercadolivre.com.br/anuncios/${String(mlId).replace('MLB', 'MLB-')}`;

// Anúncio em rankeamento ATIVO (ou null). Consulta barata (índice único ml_id) —
// chamada nos handlers de venda/item; se o anúncio não está em rankeamento,
// retorna null e o handler segue normal, custo desprezível.
// Busca o anúncio monitorado por ml_id. Com includeLinks=true também resolve
// via ranking_ad_links (anúncio de catálogo vinculado ao card) — usado só na
// contagem de VENDA; preço/estoque/snapshot usam só o ml_id principal.
async function getTracked(mlId, includeLinks = false) {
  if (!mlId) return null;
  if (!includeLinks) {
    const { rows } = await pool.query(
      `SELECT * FROM ranking_ads WHERE ml_id = $1 AND active = true`, [String(mlId)]
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT r.* FROM ranking_ads r
      WHERE r.active = true
        AND (r.ml_id = $1 OR EXISTS (
              SELECT 1 FROM ranking_ad_links l WHERE l.ranking_ad_id = r.id AND l.ml_id = $1))
      LIMIT 1`, [String(mlId)]
  );
  return rows[0] || null;
}

// Registra um evento (grava em ranking_events + notifica tela e Telegram).
// tgMode controla o Telegram:
//   'force'  → tgNotifyForce (ignora silêncio/throttle): venda/marco na fase 1.
//   'normal' → tgNotify (respeita silêncio/throttle): alterações/regressão.
//   'silent' → só tela, sem Telegram: venda/marco na fase 2 (ranqueado).
// A tela (WS) SEMPRE recebe — o histórico/timeline não muda entre fases.
async function emit(ad, eventType, message, detail = {}, tgMode = 'normal') {
  const { rows } = await pool.query(
    `INSERT INTO ranking_events (ranking_ad_id, ml_id, event_type, message, detail)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [ad.id, ad.ml_id, eventType, message, JSON.stringify(detail)]
  );
  const ev = rows[0];
  // Tela (dashboard) — consumido por pages/rankeamento.html e o sino do topbar.
  await publish('ranking_event', {
    ranking_ad_id: ad.id, ml_id: ad.ml_id, title: ad.title,
    event_type: eventType, message, detail, id: ev.id, created_at: ev.created_at,
  });
  // Telegram — tópico dedicado tg_rankeamento.
  if (tgMode === 'force') await tgNotifyForce('tg_rankeamento', message);
  else if (tgMode === 'normal') await tgNotify('tg_rankeamento', message);
  // 'silent' → não notifica no Telegram.
  return ev;
}

// Uma venda de um anúncio em rankeamento. `valorNum` é o valor da LINHA do
// pedido (unit_price × quantity) desse item, não o total do pedido.
async function onSale({ mlId, order, valorNum, comprador, saleDate, realtime = true }) {
  const ad = await getTracked(mlId, true); // inclui anúncios de catálogo vinculados
  if (!ad) return;

  const orderId = order?.id || order?.ml_id || null;

  // Só conta vendas do DIA em que o anúncio entrou em rankeamento em diante
  // (comparação por data em SP, não timestamp) — assim uma venda mais cedo no
  // mesmo dia da marcação conta, mas o histórico de dias anteriores (que o
  // sync-vendas de 72h reprocessa) fica de fora e não infla o contador.
  const spDate = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (saleDate && ad.started_at && spDate(saleDate) < spDate(ad.started_at)) return;

  // Idempotência por order_id: se a venda deste pedido já foi registrada para
  // este anúncio, não conta de novo. É o que permite chamar onSale sem medo em
  // re-processos / sync / webhooks tardios (nenhuma venda é perdida nem dobrada).
  if (orderId) {
    const dup = await pool.query(
      `SELECT 1 FROM ranking_events
        WHERE ranking_ad_id = $1 AND event_type = 'venda' AND detail->>'order_id' = $2 LIMIT 1`,
      [ad.id, String(orderId)]
    );
    if (dup.rows.length) return;
  }

  // v80 — fase RECUPERAÇÃO: a 1ª venda depois da intervenção é exatamente a
  // notícia que se espera, então ganha mensagem própria. Checado ANTES do emit
  // (que grava o evento 'venda') e com o `ad` lido antes do UPDATE, pra ainda
  // ter o último last_sale_at (quantos dias ficou parado).
  let primeiraDaRecuperacao = false;
  const paradoDesde = ad.last_sale_at || ad.started_at;
  if (ad.fase === 'recuperacao' && ad.recuperacao_started_at) {
    const { rows: anteriores } = await pool.query(
      `SELECT 1 FROM ranking_events
        WHERE ranking_ad_id = $1 AND event_type = 'venda' AND created_at >= $2 LIMIT 1`,
      [ad.id, ad.recuperacao_started_at]
    );
    primeiraDaRecuperacao = !anteriores.length;
  }

  const now = new Date();
  const { rows } = await pool.query(
    `UPDATE ranking_ads
       SET sales_count = sales_count + 1,
           first_sale_at = COALESCE(first_sale_at, $2),
           last_sale_at = $2,
           updated_at = now()
     WHERE id = $1
     RETURNING sales_count, first_sale_at`,
    [ad.id, now]
  );
  const count = rows[0].sales_count;

  // Telegram só em tempo real e na fase 1 (rankeando). Fora disso (fase 2
  // ranqueado, catch-up de sync ou venda >24h) a venda conta em silêncio (tela).
  const isRanq = ad.fase === 'ranqueado';
  const notify = (realtime && !isRanq) ? 'force' : 'silent';
  const every0 = ad.milestone_every || 5;
  const faltam = (every0 - (count % every0)) % every0;
  const diasParado = paradoDesde ? Math.floor((now.getTime() - new Date(paradoDesde).getTime()) / 86400000) : null;
  const msgVenda = primeiraDaRecuperacao
    ? `🎉 <b>DESTRAVOU! 1ª venda desde a recuperação</b>\n📦 ${ad.title || ad.ml_id}\n${diasParado != null ? `⏳ Estava <b>${diasParado} dia(s)</b> sem vender\n` : ''}💰 ${BRL(valorNum)}\n👤 ${comprador || '—'}\n🕐 ${saleDate ? fmtDT(saleDate) : fmtDT(now)}\n✅ As alterações fizeram efeito — avalie voltar pra <b>Em rankeamento</b>.\n🔗 ${linkOf(ad.ml_id)}`
    : `🏆 <b>Venda de produto em rankeamento!</b>\n📦 ${ad.title || ad.ml_id}\n🔢 Venda nº <b>${count}</b> em rankeamento\n💰 ${BRL(valorNum)}\n👤 ${comprador || '—'}\n🕐 ${saleDate ? fmtDT(saleDate) : fmtDT(now)}\n🎯 ${faltam === 0 ? 'Marco atingido!' : `Faltam ${faltam} p/ o próximo marco (a cada ${every0})`}\n🔗 ${linkOf(ad.ml_id)}`;
  await emit(ad, 'venda', msgVenda,
    { order_id: orderId || '—', valor: valorNum, comprador, sales_count: count, recuperou: primeiraDaRecuperacao || undefined }, notify);

  // Marco a cada N vendas — resumo de ritmo (Telegram só em tempo real).
  const every = ad.milestone_every || 5;
  if (count > 0 && count % every === 0) {
    await milestone({ ...ad, sales_count: count, first_sale_at: rows[0].first_sale_at }, realtime);
  }
}

// Marco (a cada N vendas): total, tempo desde a 1ª venda, ritmo/dia e faturamento
// do anúncio no período em rankeamento.
async function milestone(ad, realtime = true) {
  const firstAt = ad.first_sale_at ? new Date(ad.first_sale_at) : new Date();
  const dias = Math.max(1, (Date.now() - firstAt.getTime()) / 86400000);
  const ritmo = (ad.sales_count / dias).toFixed(1);
  // Faturamento = soma dos valores das próprias vendas registradas em
  // ranking_events (agnóstico de marketplace: ML e Shopee gravam o mesmo campo
  // detail.valor; não depende de orders.item_id, que a Shopee não popula).
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM((detail->>'valor')::numeric), 0) AS fat
       FROM ranking_events WHERE ranking_ad_id = $1 AND event_type = 'venda'`,
    [ad.id]
  );
  const fat = rows[0].fat;

  // TROCA AUTOMÁTICA DE CICLO: a cada múltiplo de N vendas o ciclo avança
  // sozinho (5 vendas → ciclo 2, 10 → ciclo 3, e assim por diante). Só na fase
  // `rankeando` — ranqueado/monitoramento/recuperação não trabalham por ciclo
  // de campanha. O botão "Novo ciclo" do card continua existindo pra forçar a
  // virada antes do marco; como aqui é `ciclo + 1` (e não `sales/N + 1`), os
  // dois caminhos convivem sem brigar pelo número.
  const de = ad.ciclo || 1;
  let para = de;
  if (ad.fase === 'rankeando') {
    try {
      const novo = await avancarCiclo(ad.id);
      if (novo) {
        para = novo.ciclo;
        // Evento próprio na linha do tempo do card (silencioso: quem avisa no
        // Telegram é a mensagem de marco logo abaixo, pra não mandar duas).
        await emit({ ...ad, ciclo: para }, 'ciclo',
          `🔄 <b>Ciclo ${de} encerrado → Ciclo ${para}</b>\n📦 ${ad.title || ad.ml_id}\n🔢 ${ad.sales_count} vendas acumuladas`,
          { de, para, sales_count: ad.sales_count, automatico: true }, 'silent');
      }
    } catch (e) {
      // Falhar a virada não pode engolir o marco — o número de vendas segue
      // correto e a troca pode ser feita no botão do card.
      console.error(`[ranking] troca automática de ciclo falhou (ad ${ad.id}):`, e.message);
    }
  }

  const linhaCiclo = para > de
    ? `🔄 <b>Ciclo ${de} encerrado — agora no Ciclo ${para}</b> (automático a cada ${ad.milestone_every || 5} vendas)`
    : `🔄 Ciclo ${de}`;
  await emit({ ...ad, ciclo: para }, 'marco',
    `🎯 <b>Marco: ${ad.sales_count} vendas em rankeamento</b>\n📦 ${ad.title || ad.ml_id}\n⏱️ ${dias.toFixed(1)} dia(s) desde a 1ª venda\n📈 Ritmo: ${ritmo} vendas/dia\n💵 Faturamento acumulado: ${BRL(fat)}\n${linhaCiclo}\n🔗 ${linkOf(ad.ml_id)}`,
    { sales_count: ad.sales_count, dias: Number(dias.toFixed(1)), ritmo: Number(ritmo), faturamento: Number(fat), ciclo: para, ciclo_anterior: de },
    (ad.fase === 'ranqueado' || !realtime) ? 'silent' : 'force');
}

// Alterações do anúncio detectadas no sync do item (handleItem) — preço, estoque
// e status. Zero custo de API: usa o item que o worker já buscou.
async function onItemChange({ mlId, price, availableQuantity, status, title }) {
  const ad = await getTracked(mlId);
  if (!ad) return;
  const sets = [], vals = [ad.id]; let updated = false;

  if (price != null && ad.last_price != null && Number(price) !== Number(ad.last_price)) {
    const dir = Number(price) > Number(ad.last_price) ? '⬆️ subiu' : '⬇️ baixou';
    await emit(ad, 'preco',
      `💲 <b>Preço ${dir}</b>\n📦 ${title || ad.title || ad.ml_id}\n${BRL(ad.last_price)} → <b>${BRL(price)}</b>`,
      { de: Number(ad.last_price), para: Number(price) });
    updated = true;
  }
  if (availableQuantity != null && ad.last_available_quantity != null && Number(availableQuantity) !== Number(ad.last_available_quantity)) {
    const zerou = Number(availableQuantity) === 0 ? '\n⚠️ <b>ESTOQUE ZERADO</b> — anúncio pode pausar e perder rankeamento!' : '';
    await emit(ad, 'estoque',
      `📦 <b>Estoque alterado</b>\n${title || ad.title || ad.ml_id}\n${ad.last_available_quantity} → <b>${availableQuantity}</b> un.${zerou}`,
      { de: Number(ad.last_available_quantity), para: Number(availableQuantity) });
    updated = true;
  }
  if (status && ad.last_status && status !== ad.last_status) {
    await emit(ad, 'status',
      `🚦 <b>Status do anúncio mudou</b>\n${title || ad.title || ad.ml_id}\n${ad.last_status} → <b>${status}</b>`,
      { de: ad.last_status, para: status });
    updated = true;
  }
  // Atualiza os últimos valores conhecidos sempre (mesmo sem evento, pra semear
  // a 1ª leitura de anúncios recém-marcados sem disparar alerta falso).
  await pool.query(
    `UPDATE ranking_ads
       SET last_price = COALESCE($2, last_price),
           last_available_quantity = COALESCE($3, last_available_quantity),
           last_status = COALESCE($4, last_status),
           updated_at = now()
     WHERE id = $1`,
    [ad.id, price ?? null, availableQuantity ?? null, status ?? null]
  );
  return updated;
}

// Webhook catalog_item_competition_status (v88) — atualização de Buy-Box em
// TEMPO REAL, complementar ao job diário sync-catalog-competition (que cobre
// "aos poucos" o catálogo inteiro) e ao snapshot periódico (que só roda pras
// fases rankeando/ranqueado/monitoramento/recuperacao, nunca 'catalogo').
// ⚠️ Tópico `catalog_item_competition_status` PRECISA estar habilitado no
// painel de desenvolvedor do Mercado Livre pra este app — se não estiver, o
// ML nunca envia o webhook e esta função nunca é chamada; o job diário
// continua sendo a única fonte, sem qualquer regressão. Formato exato do
// `resource` não confirmado ao vivo (mesma ressalva já registrada pra outras
// integrações não testadas em produção — ver known-bugs.md/decisions.md).
async function onCatalogCompetitionUpdate(itemId, storeId) {
  const ml = require('./mlClient'); // require tardio, mesmo motivo do snapshot()
  const { fetchAndSaveCatalogCompetition } = require('./catalogCompetition');
  const ptw = await fetchAndSaveCatalogCompetition(ml, itemId, storeId);

  // Notifica só se o item estiver tracked em QUALQUER fase (não só 'catalogo'
  // — um item em recuperação também mostra buy-box no card, mesma regra do
  // snapshot()). Mesma mensagem/formato do evento 'buybox' já emitido em
  // snapshot() — não é uma 2ª fórmula, é o mesmo emit() com o mesmo texto,
  // só disparado por um gatilho diferente (webhook em vez de polling 6h/1x-dia).
  const ad = await getTracked(itemId);
  if (!ad) return ptw;
  const ganhando = ptw.winner?.item_id != null ? String(ptw.winner.item_id) === String(itemId) : null;
  if (ganhando != null && ad.last_buybox != null && ganhando !== ad.last_buybox) {
    await emit(ad, 'buybox', ganhando
      ? `🥇 <b>GANHOU o buy-box!</b>\n📦 ${ad.title || ad.ml_id}`
      : `⚠️ <b>PERDEU o buy-box</b>\n📦 ${ad.title || ad.ml_id}`, { ganhando });
  }
  if (ganhando != null) {
    await pool.query(`UPDATE ranking_ads SET last_buybox = $2, updated_at = now() WHERE id = $1`, [ad.id, ganhando]);
  }
  return ptw;
}

// Snapshot periódico (job): pra cada anúncio ativo, coleta visitas (API) e lê
// qualidade (item_seo_score) e buy-box (catalog_competition) do banco, e notifica
// quando muda. `faseAlvo` limita quais anúncios processar:
//   'rankeando' (a cada 6h) → notifica QUALQUER mudança (subiu/caiu), fase de empurrar.
//   'ranqueado' (1x/dia)    → SÓ regressão (perdeu buy-box, saiu/caiu nos Mais
//                              Vendidos, visitas caíram ≥40%, qualidade piorou) +
//                              alerta "esfriou" (sem vender há N dias).
// Só anúncios do Mercado Livre — visitas/qualidade/buy-box/highlights usam a API
// do ML. Shopee é ignorado (recebe só venda/marco). Poucos anúncios (limite de
// negócio), não varre o catálogo, então não pesa no rate limit.
async function snapshot(faseAlvo = 'rankeando') {
  const ml = require('./mlClient'); // require tardio: evita custo se o job nunca roda
  const COLD_DAYS = 3;      // "esfriou" = sem vender há N dias (só fase ranqueado)
  const DECISAO_DIAS = 15;  // v80: em recuperação, N dias parado = hora de decidir
  const { rows: ads } = await pool.query(
    `SELECT r.* FROM ranking_ads r
       JOIN items i ON i.ml_id = r.ml_id
       LEFT JOIN marketplaces m ON m.id = i.marketplace_id
      WHERE r.active = true AND COALESCE(m.code, 'ML') = 'ML' AND r.fase = $1`,
    [faseAlvo]
  );
  const isRanq = faseAlvo === 'ranqueado';
  let checked = 0;
  for (const ad of ads) {
    try {
      // Visitas (últimos 1 dia) — best-effort.
      let visits = null;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const v = await ml.getItemVisits(ad.ml_id, today, ad.store_id);
        visits = v?.total_visits ?? (Array.isArray(v?.results) ? v.results.reduce((a, r) => a + (r.total || 0), 0) : null);
      } catch (_) { /* sem visitas agora */ }

      // Qualidade + buy-box do banco (jobs já populam essas tabelas).
      const { rows: q } = await pool.query(`SELECT score FROM item_seo_score WHERE item_id = $1`, [ad.ml_id]);
      const seo = q[0]?.score != null ? Number(q[0].score) : null;
      const { rows: c } = await pool.query(`SELECT winner_item_id, catalog_product_id FROM catalog_competition WHERE item_id = $1`, [ad.ml_id]);
      const buybox = c.length ? (String(c[0].winner_item_id) === String(ad.ml_id)) : null;

      // Posição nos "Mais Vendidos" da categoria (highlights). Casa por item id
      // (type ITEM) ou pelo catalog_product_id (type PRODUCT). null = fora do
      // ranking de destaque. best-effort (a API 404 se a categoria não tem highlights).
      let highlightPos = null;
      const { rows: cat } = await pool.query(`SELECT category_id FROM items WHERE ml_id = $1`, [ad.ml_id]);
      const categoryId = cat[0]?.category_id;
      if (categoryId) {
        try {
          const h = await ml.getCategoryHighlights(categoryId, ad.store_id);
          const prodId = c[0]?.catalog_product_id;
          const hit = (h?.content || []).find(x =>
            String(x.id) === String(ad.ml_id) || (prodId && String(x.id) === String(prodId)));
          highlightPos = hit ? Number(hit.position) : null;
        } catch (_) { /* categoria sem highlights */ }
      }

      // Visitas: fase 1 alerta qualquer variação; fase 2 só QUEDA forte (≥40%).
      if (visits != null && ad.last_visits != null && visits !== Number(ad.last_visits)) {
        const last = Number(ad.last_visits);
        const caiu = visits < last;
        const quedaForte = caiu && visits < last * 0.6; // -40%+
        if (!isRanq || quedaForte) {
          const dir = caiu ? (isRanq ? '⚠️ despencaram' : '⬇️') : '⬆️';
          await emit(ad, 'visitas', `👁️ <b>Visitas ${dir}</b>\n📦 ${ad.title || ad.ml_id}\n${last} → <b>${visits}</b> (últ. dia)`, { de: last, para: visits });
        }
      }
      // Qualidade: fase 2 só quando PIORA.
      if (seo != null && ad.last_seo_score != null && seo !== Number(ad.last_seo_score)) {
        const piorou = seo < Number(ad.last_seo_score);
        if (!isRanq || piorou) {
          await emit(ad, 'qualidade', `⭐ <b>Qualidade ${piorou ? '⬇️ piorou' : '⬆️ melhorou'}</b>\n📦 ${ad.title || ad.ml_id}\n${ad.last_seo_score} → <b>${seo}</b>`, { de: Number(ad.last_seo_score), para: seo });
        }
      }
      // Buy-box: fase 2 só quando PERDE.
      if (buybox != null && ad.last_buybox != null && buybox !== ad.last_buybox) {
        if (!isRanq || !buybox) {
          await emit(ad, 'buybox', buybox
            ? `🥇 <b>GANHOU o buy-box!</b>\n📦 ${ad.title || ad.ml_id}`
            : `⚠️ <b>PERDEU o buy-box</b>\n📦 ${ad.title || ad.ml_id}`, { ganhando: buybox });
        }
      }
      // Mais Vendidos: entrou / saiu / mudou de posição. Fase 2 só regressão (saiu/caiu).
      if (highlightPos !== (ad.last_highlight_pos != null ? Number(ad.last_highlight_pos) : null)) {
        const antes = ad.last_highlight_pos;
        const saiu = highlightPos == null && antes != null;
        const caiu = highlightPos != null && antes != null && highlightPos > antes;
        const regressao = saiu || caiu;
        if (!isRanq || regressao) {
          let msg;
          if (highlightPos != null && antes == null) msg = `🚀 <b>ENTROU nos Mais Vendidos!</b>\n📦 ${ad.title || ad.ml_id}\n🏅 Posição <b>#${highlightPos}</b> na categoria`;
          else if (saiu) msg = `📉 <b>SAIU dos Mais Vendidos</b>\n📦 ${ad.title || ad.ml_id}\n(estava em #${antes})`;
          else { const dir = highlightPos < antes ? '⬆️ subiu' : '⬇️ caiu'; msg = `📊 <b>Mais Vendidos ${dir}</b>\n📦 ${ad.title || ad.ml_id}\n#${antes} → <b>#${highlightPos}</b> na categoria`; }
          await emit(ad, 'destaque', msg, { de: antes != null ? Number(antes) : null, para: highlightPos });
        }
      }
      // "Esfriou" (só fase ranqueado): sem vender há COLD_DAYS dias. Alerta 1x por
      // esfriamento — não repete todo dia (checa se já não avisou desde a últ. venda).
      if (isRanq && ad.last_sale_at) {
        const diasSemVenda = (Date.now() - new Date(ad.last_sale_at).getTime()) / 86400000;
        if (diasSemVenda >= COLD_DAYS) {
          const { rows: já } = await pool.query(
            `SELECT 1 FROM ranking_events WHERE ranking_ad_id = $1 AND event_type = 'esfriou' AND created_at > $2 LIMIT 1`,
            [ad.id, ad.last_sale_at]
          );
          if (!já.length) {
            await emit(ad, 'esfriou', `💤 <b>Esfriou</b>\n📦 ${ad.title || ad.ml_id}\nSem vender há <b>${Math.floor(diasSemVenda)} dia(s)</b> (ranqueado)`, { dias: Math.floor(diasSemVenda) });
          }
        }
      }
      // v80 — fase RECUPERAÇÃO: bateu DECISAO_DIAS parado, avisa 1x que é hora de
      // decidir (recuperou / segue tentando / encerra). NUNCA exclui sozinho: a
      // decisão é sempre do usuário, no card.
      if (faseAlvo === 'recuperacao') {
        const ref = ad.last_sale_at || ad.started_at;
        const diasParado = ref ? (Date.now() - new Date(ref).getTime()) / 86400000 : null;
        if (diasParado != null && diasParado >= DECISAO_DIAS) {
          const desde = ad.recuperacao_started_at || ad.started_at;
          const { rows: já } = await pool.query(
            `SELECT 1 FROM ranking_events
              WHERE ranking_ad_id = $1 AND event_type = 'sem_resultado' AND created_at > $2 LIMIT 1`,
            [ad.id, desde]
          );
          if (!já.length) {
            const { rows: nt } = await pool.query(
              `SELECT COUNT(*)::int AS n FROM ranking_notes WHERE ranking_ad_id = $1 AND tipo IS NOT NULL AND created_at >= $2`,
              [ad.id, desde]
            );
            await emit(ad, 'sem_resultado',
              `🔴 <b>Hora de decidir</b>\n📦 ${ad.title || ad.ml_id}\n⏳ <b>${Math.floor(diasParado)} dia(s)</b> sem vender\n🔧 ${nt[0].n} intervenção(ões) registrada(s) na recuperação\n👉 Abra o card e decida: <b>Recuperou</b>, seguir tentando ou <b>Encerrar</b>.`,
              { dias: Math.floor(diasParado), intervencoes: nt[0].n });
          }
        }
      }
      await pool.query(
        `UPDATE ranking_ads SET last_visits = COALESCE($2, last_visits),
           last_seo_score = COALESCE($3, last_seo_score),
           last_buybox = COALESCE($4, last_buybox),
           last_highlight_pos = $5, updated_at = now()
         WHERE id = $1`,
        [ad.id, visits, seo, buybox, highlightPos]
      );
      checked++;
    } catch (e) { console.error(`[ranking] snapshot ${ad.ml_id}:`, e.message); }
  }
  return { checked, total: ads.length };
}

// Encerra o ciclo atual e abre o próximo. Usado nos dois caminhos: automático
// (marco de N vendas, ver `milestone`) e manual (botão do card →
// POST /api/ranking/ads/:id/ciclo). É uma função só de propósito — antes a
// rota tinha essa transação inline e o caminho automático teria duplicado o
// mesmo INSERT+UPDATE, com risco de os dois divergirem.
//
// O que faz, numa transação com a linha travada (FOR UPDATE — o worker pode
// estar processando outra venda do mesmo anúncio ao mesmo tempo):
//  1. arquiva um snapshot do ciclo que fecha em `ranking_ciclos` (campanha,
//     ROAS, orçamento, preços, vendas e faturamento ACUMULADOS até aqui);
//  2. incrementa `ciclo`, desloca `preco_anterior ← preco_atual` e carimba
//     `ciclo_iniciado_em`.
// NÃO zera `sales_count` nem faturamento: eles são cumulativos através dos
// ciclos por decisão de negócio (ver business-rules.md).
async function avancarCiclo(adId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ad } = await client.query(`SELECT * FROM ranking_ads WHERE id = $1 FOR UPDATE`, [adId]);
    if (!ad.length) { await client.query('ROLLBACK'); return null; }
    const r = ad[0];
    const { rows: fat } = await client.query(
      `SELECT COALESCE(SUM((detail->>'valor')::numeric), 0) AS f FROM ranking_events
        WHERE ranking_ad_id = $1 AND event_type = 'venda'`,
      [r.id]
    );
    await client.query(
      `INSERT INTO ranking_ciclos (ranking_ad_id, ciclo, campanha_nome, ads_investido, roas, orcamento_diario, preco_anterior, preco_atual, sales_count, faturamento, iniciado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, r.ciclo || 1, r.campanha_nome, r.ads_investido, r.roas, r.orcamento_diario, r.preco_anterior, r.preco_atual, r.sales_count, fat[0].f, r.ciclo_iniciado_em]
    );
    const { rows } = await client.query(
      `UPDATE ranking_ads
          SET ciclo = COALESCE(ciclo,1) + 1,
              preco_anterior = preco_atual,   -- o preço do ciclo que fecha vira o "anterior"
              ciclo_iniciado_em = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [r.id]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// Estágio atual (fase) de um lote de item_id — usado pela tag de estágio em
// bi-vendas.html e pelo agregado "Vendas por Estágio" (routes/bi.js). Fonte
// única do join item_id→fase, nunca duplicada: considera tanto o vínculo
// direto (ranking_ads.ml_id) quanto o vínculo de catálogo (ranking_ad_links,
// ver rankeamento.md "Vínculo tradicional ↔ catálogo"). Item sem nenhuma
// linha em ranking_ads não é "erro" — só não está rastreado pelo módulo
// (nem toda venda tem um anúncio marcado em rankeamento).
async function buscarFasePorItemIds(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT x.item_id, COALESCE(ra.fase, ra2.fase) AS fase, COALESCE(ra.id, ra2.id) AS ranking_ad_id
       FROM unnest($1::text[]) AS x(item_id)
       LEFT JOIN ranking_ads ra ON ra.ml_id = x.item_id
       LEFT JOIN ranking_ad_links ral ON ral.ml_id = x.item_id
       LEFT JOIN ranking_ads ra2 ON ra2.id = ral.ranking_ad_id`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) if (r.fase) map.set(r.item_id, { fase: r.fase, ranking_ad_id: r.ranking_ad_id });
  return map;
}

module.exports = { getTracked, onSale, onItemChange, milestone, emit, snapshot, avancarCiclo, BRL, linkOf, buscarFasePorItemIds, onCatalogCompetitionUpdate };
