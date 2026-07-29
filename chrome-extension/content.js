// Content Script v2 — painel DARK sobreposto na página do anúncio (estilo
// Metrizap). Extrai o que dá da própria página (título, preço, vendedor,
// reputação, FULL, localização, avaliação, estoque, MLB, fotos e vídeos) e
// renderiza um card fixo. Continua salvando o anúncio na análise (produto
// ativo) via service-worker, e permite BAIXAR as fotos/vídeos do anúncio.
//
// Parts 1+2 (painel + dark) + download de mídia. Frete/Tarifa/"você recebe" e
// estimativas de visitas/vendas ficam pra uma fase seguinte (ver .claude).

console.log('[content] FinanceEcom v2 carregado');

const PANEL_ID = 'financeecom-panel';

// Só age em página de anúncio (tem MLB no path ou JSON-LD de Produto).
function isProductPage() {
  if (/MLB-?\d{6,}/i.test(location.href)) return true;
  return getJsonLd().some((j) => /product/i.test(j['@type'] || ''));
}

setTimeout(() => { if (isProductPage()) injectPanel(); }, 1200);

// ── Extração da página ───────────────────────────────────────────────────
function getJsonLd() {
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => { try { return JSON.parse(s.textContent); } catch (_) { return null; } })
    .filter(Boolean).flat();
}
const txt = () => document.body.innerText || '';
const q = (sel) => document.querySelector(sel);
const qt = (sel) => (q(sel)?.textContent || '').trim();

function productJsonLd() {
  return getJsonLd().find((j) => /product/i.test(j['@type'] || '')) || {};
}

function extractMlb() {
  const m = location.href.match(/MLB-?(\d{6,})/i) || txt().match(/\bMLB\s?(\d{6,})\b/);
  return m ? 'MLB' + m[1] : null;
}

function extractTitle(p) {
  return p.name || qt('h1.ui-pdp-title') || document.title.replace(/\s*\|\s*Mercado.*/i, '').trim() || null;
}

function extractPrice(p) {
  const off = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  const jl = off && (off.price != null ? off.price : off.lowPrice);
  if (jl != null) return Number(jl);
  // DOM: fração + centavos do preço principal
  const frac = qt('.ui-pdp-price__main-container .andes-money-amount__fraction')
            || qt('.andes-money-amount__fraction');
  const cents = qt('.ui-pdp-price__main-container .andes-money-amount__cents')
             || qt('.andes-money-amount__cents');
  if (frac) return Number(frac.replace(/\./g, '') + '.' + (cents || '0').padEnd(2, '0'));
  return null;
}

function extractOriginalPrice() {
  const s = qt('s.andes-money-amount--previous .andes-money-amount__fraction')
         || qt('.ui-pdp-price__original-value .andes-money-amount__fraction');
  return s ? Number(s.replace(/\./g, '')) : null;
}

function extractSeller() {
  const el = q('.ui-pdp-seller__link-trigger-button, .ui-pdp-seller__header__title, .ui-box-component-pdp__visible--desktop .ui-pdp-color--BLUE');
  let name = el ? el.textContent.trim() : null;
  if (!name) { const m = txt().match(/Vendido por\s+([A-Z0-9_\.\-]{2,40})/i); if (m) name = m[1]; }
  return name && name.length <= 40 ? name : null;
}

function extractReputation() {
  const t = txt();
  const m = t.match(/MercadoL[íi]der\s*(Platinum|Gold|Silver|Prata|Ouro|Platina)?/i);
  if (m) return ('MercadoLíder ' + (m[1] || '')).trim();
  if (/Vendedor Oficial/i.test(t)) return 'Vendedor Oficial';
  return null;
}

function extractLocation() {
  const m = txt().match(/\b([A-Z][a-zâ-ûç]+(?:\s[A-Z][a-zâ-ûç]+)*)\s*[-–]\s*([A-Z]{2})\b/);
  return m ? `${m[1]}, ${m[2]}` : null;
}

function extractFull() {
  if (q('svg[aria-label*="Full" i], img[alt*="Full" i]')) return true;
  return /\bFULL\b/.test(txt()) && /Enviado pelo Full|chega grátis|Full/i.test(txt());
}

function extractRating(p) {
  const agg = p.aggregateRating || {};
  const nota = agg.ratingValue != null ? Number(agg.ratingValue)
    : (parseFloat((qt('.ui-pdp-review__rating') || '').replace(',', '.')) || null);
  const cnt = agg.reviewCount != null ? Number(agg.reviewCount)
    : (parseInt((qt('.ui-pdp-review__amount') || '').replace(/\D/g, ''), 10) || null);
  return { nota, cnt };
}

function extractStock() {
  const m = txt().match(/\((\+?\d+)\s+dispon[íi]ve/i) || txt().match(/(\d+)\s+unidades?\s+dispon/i);
  return m ? m[1] : null;
}

function extractSold() {
  const m = txt().match(/([\+\d\.]+)\s+vendidos?/i);
  return m ? m[1].replace(/\+/, '+') : null;
}

// Data de criação do anúncio (best-effort): 1) texto "Publicado há X dias";
// 2) date_created/start_time embutido no estado da página (__PRELOADED_STATE__/
// __NEXT_DATA__). Devolve {data:'DD/MM/AAAA', dias:N} ou null.
function extractCreation() {
  const fromDays = (days) => {
    const d = new Date(Date.now() - days * 86400000);
    return { data: d.toLocaleDateString('pt-BR'), dias: days };
  };
  const t = txt();
  let m = t.match(/Publicad[oa]\s*h[áa]\s*(\d+)\s*dias?/i) || t.match(/h[áa]\s*(\d+)\s*dias?\s*(?:no ar|de an[úu]ncio)/i);
  if (m) return fromDays(parseInt(m[1], 10));
  // ISO embutido nos scripts do ML
  for (const s of document.querySelectorAll('script')) {
    const c = s.textContent || '';
    const iso = c.match(/"(?:date_created|start_time)":"(\d{4}-\d{2}-\d{2}T[\d:.\-Z+]+)"/);
    if (iso) {
      const d = new Date(iso[1]);
      if (!isNaN(d)) return { data: d.toLocaleDateString('pt-BR'), dias: Math.round((Date.now() - d) / 86400000) };
    }
  }
  return null;
}

// Fotos: JSON-LD (image) + galeria do DOM, elevadas pra alta resolução, sem duplicar.
function extractImages(p) {
  const urls = new Set();
  const add = (u) => { if (u && /mlstatic\.com/.test(u)) urls.add(hiRes(u)); };
  const im = p.image;
  if (typeof im === 'string') add(im);
  else if (Array.isArray(im)) im.forEach(add);
  document.querySelectorAll('.ui-pdp-gallery__figure img, figure.ui-pdp-gallery__figure img, .ui-pdp-thumbnail img')
    .forEach((el) => add(el.getAttribute('data-zoom') || el.src));
  return [...urls];
}
function hiRes(u) {
  return u.replace(/D_NQ_NP_(?!2X_)/, 'D_NQ_NP_2X_').replace(/-[A-Z]\.(webp|jpg|jpeg|png)/i, '-O.$1');
}

// Vídeos: best-effort. JSON-LD (video), <video src>, e clipes do ML (thumb com data-clip).
function extractVideos(p) {
  const urls = new Set();
  const v = p.video;
  if (v) (Array.isArray(v) ? v : [v]).forEach((x) => { const u = typeof x === 'string' ? x : (x.contentUrl || x.embedUrl); if (u) urls.add(u); });
  document.querySelectorAll('video source[src], video[src]').forEach((el) => urls.add(el.src));
  document.querySelectorAll('a[href*="youtube.com"], a[href*="youtu.be"]').forEach((el) => urls.add(el.href));
  return [...urls].filter(Boolean);
}

function collectAll() {
  const p = productJsonLd();
  return {
    mlb: extractMlb(), title: extractTitle(p),
    price: extractPrice(p), original: extractOriginalPrice(),
    seller: extractSeller(), reputation: extractReputation(), location: extractLocation(),
    full: extractFull(), rating: extractRating(p), stock: extractStock(), sold: extractSold(),
    creation: extractCreation(),
    images: extractImages(p), videos: extractVideos(p),
  };
}

// ── UI ───────────────────────────────────────────────────────────────────
const BRL = (v) => v == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// "MercadoLíder Platinum" → "Platinum" (badge curto estilo Metrizap)
function medalha(rep) {
  const m = String(rep).match(/Platinum|Platina|Gold|Ouro|Silver|Prata/i);
  const map = { platina: 'Platinum', ouro: 'Gold', prata: 'Silver' };
  return m ? (map[m[0].toLowerCase()] || m[0]) : rep;
}

function row(icon, label, value, right) {
  if (value == null || value === '') return '';
  return `<div class="fe-row"><span class="fe-ri">${icon}</span><div class="fe-rm">
    <div class="fe-rl">${esc(label)}</div><div class="fe-rv">${value}</div></div>
    ${right ? `<div class="fe-rr">${right}</div>` : ''}</div>`;
}

function injectPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const d = collectAll();

  const badges = [
    d.full ? '<span class="fe-bdg full">FULL</span>' : '',
    d.original && d.price && d.original > d.price
      ? `<span class="fe-bdg off">${Math.round((1 - d.price / d.original) * 100)}% OFF</span>` : '',
  ].filter(Boolean).join('');

  const rating = d.rating.nota != null
    ? `${d.rating.nota.toFixed(1).replace('.', ',')} / 5${d.rating.cnt != null ? ` · ${d.rating.cnt} avaliações` : ''}` : null;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="fe-head">
      <div class="fe-logo">◆</div>
      <div class="fe-name">FinanceEcom</div>
      <button class="fe-icobtn" id="fe-collapse" title="Recolher">▾</button>
      <button class="fe-icobtn" id="fe-close" title="Fechar">✕</button>
    </div>
    <div class="fe-body" id="fe-body">
      ${d.title ? `<div class="fe-title">${esc(d.title)}</div>` : ''}
      ${badges ? `<div class="fe-badges">${badges}</div>` : ''}
      <div class="fe-price">
        <div class="fe-pv">${BRL(d.price)}</div>
        ${d.original && d.price && d.original > d.price ? `<div class="fe-po">${BRL(d.original)}</div>` : ''}
      </div>
      ${row('🏪', 'Loja',
            (d.seller ? esc(d.seller) : '—') + (d.reputation ? ` <span class="fe-pill">${esc(medalha(d.reputation))}</span>` : ''),
            d.location ? `<span class="fe-pill loc">${esc(d.location)}</span>` : '')}
      ${row('🗓️', 'Data de criação', d.creation ? `${esc(d.creation.data)} · ${d.creation.dias} dias` : null)}
      ${row('⭐', 'Avaliação', rating)}
      ${row('📦', 'Estoque', d.stock ? `${esc(d.stock)} disponíveis` : null)}
      ${row('🛒', 'Vendas', d.sold ? esc(d.sold) : null)}
      ${row('🏷️', 'Anúncio', d.mlb ? `<span class="fe-mono">${esc(d.mlb)}</span>` : null)}
      <div class="fe-dl">
        <button class="fe-b-img" id="fe-dl-img" ${d.images.length ? '' : 'disabled'}>⬇ Fotos (${d.images.length})</button>
        <button class="fe-b-vid" id="fe-dl-vid" ${d.videos.length ? '' : 'disabled'}>⬇ Vídeos (${d.videos.length})</button>
      </div>
      <button class="fe-save" id="fe-save">＋ Salvar na análise</button>
      <div class="fe-status" id="fe-status"></div>
    </div>`;
  document.body.appendChild(panel);
  injectStyle();

  // Guarda os dados no elemento pra os handlers usarem
  panel._data = d;

  document.getElementById('fe-close').onclick = () => panel.remove();
  document.getElementById('fe-collapse').onclick = () => {
    const b = document.getElementById('fe-body');
    const c = document.getElementById('fe-collapse');
    const hidden = b.style.display === 'none';
    b.style.display = hidden ? '' : 'none';
    c.textContent = hidden ? '▾' : '▸';
  };
  document.getElementById('fe-dl-img').onclick = () => downloadMedia(d.images, d.mlb || 'anuncio', 'foto', 'fe-dl-img');
  document.getElementById('fe-dl-vid').onclick = () => downloadMedia(d.videos, d.mlb || 'anuncio', 'video', 'fe-dl-vid');
  document.getElementById('fe-save').onclick = () => saveToAnalysis(d);
}

// Baixa cada URL via service-worker (chrome.downloads). Vídeo do YouTube abre em aba.
function downloadMedia(urls, mlb, kind, btnId) {
  if (!urls || !urls.length) return;
  const btn = document.getElementById(btnId);
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '⏳ Baixando...';

  const yt = urls.filter((u) => /youtu\.?be/.test(u));
  const direct = urls.filter((u) => !/youtu\.?be/.test(u));
  yt.forEach((u) => window.open(u, '_blank'));

  if (!direct.length) {
    btn.innerHTML = yt.length ? '↗ Aberto' : orig;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; }, 2500);
    return;
  }
  chrome.runtime.sendMessage(
    { action: 'download_files', files: direct, folder: `financeecom/${mlb}`, prefix: kind },
    (res) => {
      const ok = res && res.success;
      btn.innerHTML = ok ? `✓ ${direct.length} baixada(s)` : '❌ Falhou';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; }, 2800);
    }
  );
}

// Salva o anúncio no produto ATIVO (fluxo existente do servidor).
function saveToAnalysis() {
  const btn = document.getElementById('fe-save');
  const st = document.getElementById('fe-status');
  btn.disabled = true; btn.innerHTML = '⏳ Salvando...';
  const rawData = {
    url: location.href, pageText: document.body.innerText, title: document.title,
    jsonLd: getJsonLd(), collectedAt: new Date().toISOString(),
  };
  chrome.runtime.sendMessage({ action: 'collect_data', data: rawData }, (res) => {
    if (chrome.runtime.lastError || !res) { setStatus(st, '❌ Sem resposta do serviço', false); reset(btn); return; }
    if (res.success) { setStatus(st, '✓ Produto salvo na análise', true); }
    else { setStatus(st, '⚠️ ' + (res.error || 'ative um produto no dashboard'), false); }
    reset(btn);
  });
  function reset(b) { setTimeout(() => { b.disabled = false; b.innerHTML = '＋ Salvar na análise'; }, 3000); }
}
function setStatus(el, msg, ok) { el.textContent = msg; el.className = 'fe-status ' + (ok ? 'ok' : 'err'); el.style.display = 'block'; }

// ── Estilo (dark, escopado no #financeecom-panel) ─────────────────────────
function injectStyle() {
  if (document.getElementById('fe-style')) return;
  const s = document.createElement('style');
  s.id = 'fe-style';
  s.textContent = `
  #${PANEL_ID}{position:fixed;top:74px;right:16px;z-index:2147483000;width:300px;
    font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif;
    background:#181b20;color:#e8eaed;border:1px solid #2c313a;border-radius:16px;
    box-shadow:0 18px 46px rgba(0,0,0,.55);overflow:hidden;font-size:13px;line-height:1.4;}
  #${PANEL_ID} *{box-sizing:border-box;}
  #${PANEL_ID} .fe-head{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #2c313a;}
  #${PANEL_ID} .fe-logo{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#16b364,#0b8a4d);
    display:flex;align-items:center;justify-content:center;color:#fff;font-size:.85rem;}
  #${PANEL_ID} .fe-name{font-weight:800;font-size:.95rem;flex:1;}
  #${PANEL_ID} .fe-icobtn{width:24px;height:24px;border-radius:50%;border:1px solid #2c313a;background:transparent;
    color:#8b929e;cursor:pointer;font-size:.72rem;display:flex;align-items:center;justify-content:center;padding:0;}
  #${PANEL_ID} .fe-icobtn:hover{background:#20242b;color:#e8eaed;}
  #${PANEL_ID} .fe-body{padding:12px;display:flex;flex-direction:column;gap:9px;max-height:calc(100vh - 130px);overflow:auto;}
  #${PANEL_ID} .fe-title{font-size:.82rem;font-weight:700;line-height:1.35;color:#e8eaed;}
  #${PANEL_ID} .fe-badges{display:flex;gap:6px;flex-wrap:wrap;}
  #${PANEL_ID} .fe-bdg{font-size:.64rem;font-weight:800;padding:2px 9px;border-radius:20px;}
  #${PANEL_ID} .fe-bdg.full{background:rgba(245,158,11,.16);color:#fbbf24;}
  #${PANEL_ID} .fe-bdg.off{background:rgba(22,179,100,.16);color:#4ade80;}
  #${PANEL_ID} .fe-price{display:flex;align-items:baseline;gap:9px;}
  #${PANEL_ID} .fe-pv{font-size:1.4rem;font-weight:800;letter-spacing:-.01em;font-variant-numeric:tabular-nums;}
  #${PANEL_ID} .fe-po{font-size:.8rem;color:#8b929e;text-decoration:line-through;}
  #${PANEL_ID} .fe-row{background:#20242b;border:1px solid #2c313a;border-radius:11px;padding:9px 11px;display:flex;gap:10px;align-items:flex-start;}
  #${PANEL_ID} .fe-ri{flex:none;width:18px;text-align:center;}
  #${PANEL_ID} .fe-rm{flex:1;min-width:0;}
  #${PANEL_ID} .fe-rl{font-size:.64rem;color:#8b929e;}
  #${PANEL_ID} .fe-rv{font-size:.82rem;font-weight:700;margin-top:1px;word-break:break-word;}
  #${PANEL_ID} .fe-rr{flex:none;}
  #${PANEL_ID} .fe-pill{font-size:.6rem;font-weight:700;padding:2px 8px;border-radius:20px;background:rgba(124,58,237,.22);color:#c4b5fd;white-space:nowrap;}
  #${PANEL_ID} .fe-pill.loc{background:rgba(37,99,235,.22);color:#93c5fd;}
  #${PANEL_ID} .fe-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.76rem;}
  #${PANEL_ID} .fe-dl{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:2px;}
  #${PANEL_ID} .fe-dl button{border:none;border-radius:11px;padding:10px;font-size:.74rem;font-weight:700;cursor:pointer;color:#e8eaed;}
  #${PANEL_ID} .fe-b-img{background:#000;}
  #${PANEL_ID} .fe-b-vid{background:rgba(22,179,100,.16);color:#4ade80;border:1px solid #1f6b46;}
  #${PANEL_ID} .fe-dl button:disabled{opacity:.4;cursor:not-allowed;}
  #${PANEL_ID} .fe-save{border:none;border-radius:11px;padding:11px;font-size:.8rem;font-weight:800;cursor:pointer;
    background:linear-gradient(135deg,#16b364,#0b8a4d);color:#fff;}
  #${PANEL_ID} .fe-save:disabled{opacity:.6;cursor:default;}
  #${PANEL_ID} .fe-status{display:none;text-align:center;font-size:.72rem;font-weight:700;padding:7px;border-radius:9px;}
  #${PANEL_ID} .fe-status.ok{background:rgba(22,179,100,.16);color:#4ade80;}
  #${PANEL_ID} .fe-status.err{background:rgba(239,68,68,.16);color:#fca5a5;}
  #${PANEL_ID} .fe-body::-webkit-scrollbar{width:6px;} #${PANEL_ID} .fe-body::-webkit-scrollbar-thumb{background:#2c313a;border-radius:3px;}`;
  document.head.appendChild(s);
}
