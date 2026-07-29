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

// Blob de estado embutido do ML (contém seller/endereço confiáveis). O content
// script não lê window.__PRELOADED_STATE__ (mundo isolado), mas lê o TEXTO dos
// <script>. Concatena os scripts grandes uma vez pra as buscas por regex.
let _stateCache = null;
function pageState() {
  if (_stateCache != null) return _stateCache;
  let blob = '';
  for (const s of document.querySelectorAll('script')) {
    const c = s.textContent || '';
    if (c.length > 400 && /nickname|seller|city|__PRELOADED_STATE__/.test(c)) blob += '\n' + c;
  }
  _stateCache = blob;
  return blob;
}
function jsonVal(re) { const m = pageState().match(re); return m ? m[1] : null; }

function extractSeller() {
  // 1) DOM (loja oficial / vendedor)
  const el = q('.ui-pdp-seller__link-trigger-button .ui-pdp-color--BLUE, .ui-pdp-seller__header__title, .ui-seller-data-header__title, .ui-vip-profile-info__name, .store-info__name, .ui-pdp-seller__link-trigger-button');
  let name = el ? el.textContent.trim() : null;
  // 2) "X · Loja oficial" ou "Vendido por X"
  if (!name) { const m = txt().match(/\n\s*([A-Za-zÀ-ú0-9_ .&-]{2,40})\s*\n\s*Loja oficial/i); if (m) name = m[1].trim(); }
  if (!name) { const m = txt().match(/Vendido por\s+([A-Za-zÀ-ú0-9_\.\-]{2,40})/i); if (m) name = m[1].trim(); }
  // 3) JSON embutido
  if (!name) name = jsonVal(/"(?:seller|store)[^"]*"[^{]*?"nickname":"([^"]{2,40})"/i) || jsonVal(/"nickname":"([^"]{2,40})"/i);
  return name && name.length <= 40 ? name : null;
}

function extractReputation() {
  const t = txt();
  const m = t.match(/MercadoL[íi]der\s*(Platinum|Gold|Silver|Prata|Ouro|Platina)?/i);
  if (m) return ('MercadoLíder ' + (m[1] || '')).trim();
  if (/Loja oficial/i.test(t)) return 'Loja oficial';
  if (/Vendedor Oficial/i.test(t)) return 'Vendedor Oficial';
  return null;
}

function extractLocation() {
  // JSON embutido do endereço (mais confiável): city + state
  const city = jsonVal(/"city":\s*\{\s*"[^"]*":\s*"([^"]{2,40})"/i) || jsonVal(/"city_name":"([^"]{2,40})"/i);
  const state = jsonVal(/"state":\s*\{\s*"[^"]*":\s*"([^"]{2,40})"/i) || jsonVal(/"state_name":"([^"]{2,40})"/i);
  if (city) return state ? `${city}, ${uf(state)}` : city;
  // Texto "Cidade - UF"
  const m = txt().match(/\b([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)*)\s*[-–]\s*([A-Z]{2})\b/);
  return m ? `${m[1]}, ${m[2]}` : null;
}
// "São Paulo" → SP quando vier o nome por extenso
function uf(s) {
  const map = { 'são paulo': 'SP', 'rio de janeiro': 'RJ', 'minas gerais': 'MG', 'paraná': 'PR',
    'santa catarina': 'SC', 'rio grande do sul': 'RS', 'bahia': 'BA', 'goiás': 'GO', 'ceará': 'CE',
    'pernambuco': 'PE', 'espírito santo': 'ES', 'distrito federal': 'DF', 'pará': 'PA', 'mato grosso': 'MT',
    'mato grosso do sul': 'MS', 'maranhão': 'MA', 'paraíba': 'PB', 'amazonas': 'AM' };
  return /^[A-Z]{2}$/.test(s) ? s : (map[s.toLowerCase()] || s);
}

// Loja oficial: nº de seguidores e de produtos ("+6.300 Seguidores", "+50 Produtos")
function extractFollowers() { const m = txt().match(/([\d.]+\+?|\+[\d.]+)\s*Seguidores/i); return m ? m[1] : null; }
function extractProductsCount() { const m = txt().match(/([\d.]+\+?|\+[\d.]+)\s*Produtos/i); return m ? m[1] : null; }

// "O que você precisa saber sobre este produto" → bullets de destaque.
function extractHighlights() {
  const box = q('.ui-pdp-highlighted-specs-res, .ui-vpp-highlighted-specs__features, .ui-pdp-features');
  let items = box ? Array.from(box.querySelectorAll('li, p')).map((e) => e.textContent.trim()).filter(Boolean) : [];
  if (!items.length) {
    const t = txt();
    const i = t.search(/O que você precisa saber sobre este produto/i);
    if (i >= 0) items = t.slice(i + 44, i + 700).split('\n').map((s) => s.trim())
      .filter((s) => s.length > 8 && s.length < 160).slice(0, 6);
  }
  return items.length ? [...new Set(items)].slice(0, 6) : null;
}

// Descrição do anúncio.
function extractDescription() {
  const el = q('.ui-pdp-description__content, [data-testid="content"] .ui-pdp-description__content');
  let d = el ? el.textContent.trim() : null;
  if (!d) { const t = txt(); const i = t.search(/Descri[çc][ãa]o\s*\n/i); if (i >= 0) d = t.slice(i + 10, i + 1200).trim(); }
  return d && d.length > 20 ? d.slice(0, 1500) : null;
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
    followers: extractFollowers(), products: extractProductsCount(),
    highlights: extractHighlights(), description: extractDescription(),
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
      <button class="fe-icobtn" id="fe-min" title="Minimizar">—</button>
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
      ${(d.followers || d.products) ? row('👥', 'Loja oficial',
            [d.followers ? `${esc(d.followers)} seguidores` : '', d.products ? `${esc(d.products)} produtos` : ''].filter(Boolean).join(' · ')) : ''}
      ${row('🗓️', 'Data de criação', d.creation ? `${esc(d.creation.data)} · ${d.creation.dias} dias` : null)}
      ${row('⭐', 'Avaliação', rating)}
      ${row('📦', 'Estoque', d.stock ? `${esc(d.stock)} disponíveis` : null)}
      ${row('🛒', 'Vendas', d.sold ? esc(d.sold) : null)}
      ${d.mlb ? `<div class="fe-row"><span class="fe-ri">🏷️</span><div class="fe-rm">
        <div class="fe-rl">Código do anúncio</div><div class="fe-rv"><span class="fe-mono">${esc(d.mlb)}</span></div></div>
        <button class="fe-copy" id="fe-copy" title="Copiar MLB">⧉</button></div>` : ''}
      ${d.highlights ? `<details class="fe-det"><summary>📋 O que você precisa saber</summary>
        <ul class="fe-hl">${d.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></details>` : ''}
      ${d.description ? `<details class="fe-det"><summary>📝 Descrição</summary>
        <div class="fe-desc">${esc(d.description)}</div></details>` : ''}
      <div class="fe-dl">
        <button class="fe-b-img" id="fe-dl-img" ${d.images.length ? '' : 'disabled'}>⬇ Fotos (${d.images.length})</button>
        <button class="fe-b-vid" id="fe-dl-vid" ${d.videos.length ? '' : 'disabled'}>⬇ Vídeos (${d.videos.length})</button>
      </div>
      <button class="fe-save" id="fe-save">＋ Salvar na análise</button>
      <div class="fe-status" id="fe-status"></div>
    </div>`;
  document.body.appendChild(panel);
  injectStyle();
  ensureLauncher();

  document.getElementById('fe-close').onclick = () => { panel.remove(); showLauncher(false); };
  document.getElementById('fe-min').onclick = () => { panel.style.display = 'none'; showLauncher(true); };
  const copyBtn = document.getElementById('fe-copy');
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard.writeText(d.mlb).then(() => { copyBtn.textContent = '✓'; setTimeout(() => copyBtn.textContent = '⧉', 1500); });
  };
  document.getElementById('fe-dl-img').onclick = () => downloadMedia(d.images, d.mlb || 'anuncio', 'foto', 'fe-dl-img');
  document.getElementById('fe-dl-vid').onclick = () => downloadMedia(d.videos, d.mlb || 'anuncio', 'video', 'fe-dl-vid');
  document.getElementById('fe-save').onclick = () => saveToAnalysis(d);
}

// Ícone flutuante no canto (aparece quando o painel é minimizado/fechado).
function ensureLauncher() {
  if (document.getElementById('fe-launcher')) return;
  const b = document.createElement('button');
  b.id = 'fe-launcher';
  b.title = 'Abrir FinanceEcom';
  b.textContent = '◆';
  b.onclick = () => {
    const p = document.getElementById(PANEL_ID);
    if (p) { p.style.display = ''; } else { injectPanel(); }
    showLauncher(false);
  };
  document.body.appendChild(b);
  showLauncher(false);
}
function showLauncher(on) {
  const b = document.getElementById('fe-launcher');
  if (b) b.style.display = on ? 'flex' : 'none';
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

// Salva o anúncio no produto ATIVO (fluxo existente do servidor). Anexa os
// campos já extraídos (loja, seguidores, produtos, highlights, descrição) em
// `extracted` pra o servidor tê-los limpos no `raw`, além do pageText.
function saveToAnalysis(d) {
  const btn = document.getElementById('fe-save');
  const st = document.getElementById('fe-status');
  btn.disabled = true; btn.innerHTML = '⏳ Salvando...';
  const rawData = {
    url: location.href, pageText: document.body.innerText, title: document.title,
    jsonLd: getJsonLd(), extracted: d || null, collectedAt: new Date().toISOString(),
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
  #${PANEL_ID}{position:fixed;top:70px;right:18px;z-index:2147483000;width:360px;
    font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif;
    background:#181b20;color:#e8eaed;border:1px solid #2c313a;border-radius:16px;
    box-shadow:0 18px 46px rgba(0,0,0,.55);overflow:hidden;font-size:14px;line-height:1.45;}
  #${PANEL_ID} *{box-sizing:border-box;}
  #${PANEL_ID} .fe-head{display:flex;align-items:center;gap:9px;padding:13px 14px;border-bottom:1px solid #2c313a;}
  #${PANEL_ID} .fe-logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#16b364,#0b8a4d);
    display:flex;align-items:center;justify-content:center;color:#fff;font-size:1rem;}
  #${PANEL_ID} .fe-name{font-weight:800;font-size:1.05rem;flex:1;}
  #${PANEL_ID} .fe-icobtn{width:28px;height:28px;border-radius:50%;border:1px solid #2c313a;background:transparent;
    color:#8b929e;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;}
  #${PANEL_ID} .fe-icobtn:hover{background:#20242b;color:#e8eaed;}
  #${PANEL_ID} .fe-body{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 120px);overflow:auto;}
  #${PANEL_ID} .fe-title{font-size:.92rem;font-weight:700;line-height:1.4;color:#e8eaed;}
  #${PANEL_ID} .fe-badges{display:flex;gap:7px;flex-wrap:wrap;}
  #${PANEL_ID} .fe-bdg{font-size:.72rem;font-weight:800;padding:3px 11px;border-radius:20px;}
  #${PANEL_ID} .fe-bdg.full{background:rgba(245,158,11,.16);color:#fbbf24;}
  #${PANEL_ID} .fe-bdg.off{background:rgba(22,179,100,.16);color:#4ade80;}
  #${PANEL_ID} .fe-price{display:flex;align-items:baseline;gap:10px;}
  #${PANEL_ID} .fe-pv{font-size:1.65rem;font-weight:800;letter-spacing:-.01em;font-variant-numeric:tabular-nums;}
  #${PANEL_ID} .fe-po{font-size:.9rem;color:#8b929e;text-decoration:line-through;}
  #${PANEL_ID} .fe-row{background:#20242b;border:1px solid #2c313a;border-radius:12px;padding:11px 13px;display:flex;gap:11px;align-items:center;}
  #${PANEL_ID} .fe-ri{flex:none;width:20px;text-align:center;font-size:1rem;}
  #${PANEL_ID} .fe-rm{flex:1;min-width:0;}
  #${PANEL_ID} .fe-rl{font-size:.72rem;color:#8b929e;}
  #${PANEL_ID} .fe-rv{font-size:.92rem;font-weight:700;margin-top:2px;word-break:break-word;}
  #${PANEL_ID} .fe-rr{flex:none;}
  #${PANEL_ID} .fe-pill{font-size:.68rem;font-weight:700;padding:3px 9px;border-radius:20px;background:rgba(124,58,237,.22);color:#c4b5fd;white-space:nowrap;}
  #${PANEL_ID} .fe-pill.loc{background:rgba(37,99,235,.22);color:#93c5fd;}
  #${PANEL_ID} .fe-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86rem;}
  #${PANEL_ID} .fe-copy{flex:none;width:30px;height:30px;border-radius:8px;border:1px solid #2c313a;background:#181b20;
    color:#93c5fd;cursor:pointer;font-size:.95rem;display:flex;align-items:center;justify-content:center;}
  #${PANEL_ID} .fe-copy:hover{background:#20242b;}
  #${PANEL_ID} .fe-det{background:#20242b;border:1px solid #2c313a;border-radius:12px;padding:4px 13px;}
  #${PANEL_ID} .fe-det summary{cursor:pointer;font-size:.8rem;font-weight:700;color:#b9bec7;padding:8px 0;list-style:none;}
  #${PANEL_ID} .fe-det summary::-webkit-details-marker{display:none;}
  #${PANEL_ID} .fe-det[open] summary{border-bottom:1px solid #2c313a;margin-bottom:8px;}
  #${PANEL_ID} .fe-hl{margin:0 0 8px;padding-left:18px;font-size:.8rem;color:#cdd2da;display:flex;flex-direction:column;gap:4px;}
  #${PANEL_ID} .fe-desc{font-size:.8rem;color:#cdd2da;line-height:1.5;max-height:200px;overflow:auto;padding-bottom:8px;white-space:pre-line;}
  #${PANEL_ID} .fe-dl{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:2px;}
  #${PANEL_ID} .fe-dl button{border:none;border-radius:12px;padding:12px;font-size:.82rem;font-weight:700;cursor:pointer;color:#e8eaed;}
  #${PANEL_ID} .fe-b-img{background:#000;}
  #${PANEL_ID} .fe-b-vid{background:rgba(22,179,100,.16);color:#4ade80;border:1px solid #1f6b46;}
  #${PANEL_ID} .fe-dl button:disabled{opacity:.4;cursor:not-allowed;}
  #${PANEL_ID} .fe-save{border:none;border-radius:12px;padding:13px;font-size:.9rem;font-weight:800;cursor:pointer;
    background:linear-gradient(135deg,#16b364,#0b8a4d);color:#fff;}
  #${PANEL_ID} .fe-save:disabled{opacity:.6;cursor:default;}
  #${PANEL_ID} .fe-status{display:none;text-align:center;font-size:.8rem;font-weight:700;padding:8px;border-radius:9px;}
  #${PANEL_ID} .fe-status.ok{background:rgba(22,179,100,.16);color:#4ade80;}
  #${PANEL_ID} .fe-status.err{background:rgba(239,68,68,.16);color:#fca5a5;}
  #${PANEL_ID} .fe-body::-webkit-scrollbar{width:7px;} #${PANEL_ID} .fe-body::-webkit-scrollbar-thumb{background:#2c313a;border-radius:3px;}
  #fe-launcher{position:fixed;top:70px;right:18px;z-index:2147483000;width:52px;height:52px;border-radius:50%;
    border:none;cursor:pointer;background:linear-gradient(135deg,#16b364,#0b8a4d);color:#fff;font-size:1.4rem;
    box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;}
  #fe-launcher:hover{transform:scale(1.06);}`;
  document.head.appendChild(s);
}
