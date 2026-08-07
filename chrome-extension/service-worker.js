// Service Worker v1 — central logic, comunicação com content script e backend

console.log('[SW] Service Worker carregado');

// Ouvir mensagens do Content Script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[SW] Mensagem recebida:', request.action);

  if (request.action === 'collect_data') {
    handleCollectData(request.data, sendResponse);
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'get_api_url') {
    chrome.storage.local.get(['apiUrl'], (result) => {
      sendResponse({ apiUrl: result.apiUrl || null });
    });
    return true;
  }

  if (request.action === 'download_files') {
    handleDownloadFiles(request, sendResponse);
    return true; // resposta assíncrona
  }
});

// Baixa uma lista de URLs (fotos/vídeos do anúncio) via chrome.downloads.
// Cada arquivo vai pra subpasta financeecom/<MLB>/ com nome sequencial. Ignora
// falhas individuais (retorna quantas foram aceitas).
async function handleDownloadFiles(request, sendResponse) {
  try {
    const { files = [], folder = 'financeecom', prefix = 'arquivo' } = request;
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const url = files[i];
      const ext = (url.split('?')[0].match(/\.(webp|jpg|jpeg|png|mp4|webm|mov)$/i) || [, 'jpg'])[1];
      const filename = `${folder}/${prefix}-${String(i + 1).padStart(2, '0')}.${ext}`.replace(/[^\w\-\/.]/g, '_');
      try {
        await new Promise((resolve, reject) => {
          chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, (id) => {
            if (chrome.runtime.lastError || id == null) reject(chrome.runtime.lastError || new Error('sem id'));
            else resolve(id);
          });
        });
        ok++;
      } catch (e) { console.warn('[SW] download falhou:', url, e.message); }
    }
    sendResponse({ success: ok > 0, downloaded: ok, total: files.length });
  } catch (e) {
    console.error('[SW] handleDownloadFiles erro:', e);
    sendResponse({ success: false, error: e.message });
  }
}

// Coletar dados e enviar ao backend
async function handleCollectData(data, sendResponse) {
  try {
    console.log('[SW] Processando coleta de dados...');

    // Recuperar API URL (padrão: servidor de produção)
    const result = await chrome.storage.local.get(['apiUrl']);
    const apiUrl = (result.apiUrl && result.apiUrl.trim()) || 'https://multimixvendas.duckdns.org';

    console.log('[SW] Enviando para:', `${apiUrl}/extension/anuncio`);

    // Envia o anúncio pro produto ATIVO (o servidor resolve qual é). Retry exponencial.
    const response = await fetchWithRetry(`${apiUrl}/extension/anuncio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'mercadolivre',
        rawData: data,
        collectedAt: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();
    console.log('[SW] Resposta do backend:', responseData);

    sendResponse({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error('[SW] Erro ao enviar dados:', error);
    sendResponse({
      success: false,
      error: error.message,
    });
  }
}

// Fetch com retry exponencial
async function fetchWithRetry(url, options, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[SW] Tentativa ${attempt + 1}/${maxRetries}...`);
      const response = await Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout após 30s')), 30000)
        ),
      ]);
      return response;
    } catch (error) {
      lastError = error;
      console.error(`[SW] Tentativa ${attempt + 1} falhou:`, error.message);

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[SW] Aguardando ${delay}ms antes da próxima tentativa...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Todas as tentativas falharam');
}

// ═══════════════════════════════════════════════════════════════════════════
// MONITORAMENTO AUTOMÁTICO DE CONCORRENTES (background, sem clique do usuário)
// A cada ciclo (chrome.alarms): pega os concorrentes mais desatualizados no
// backend, abre cada um numa aba OCULTA, pede a captura ao content script,
// envia ao backend e fecha a aba. Máx. 3 abas simultâneas. Recoleta 1×/dia (o
// backend só devolve quem está com last_checked_at > 24h). Ver .claude/analise-produtos.md.
// ═══════════════════════════════════════════════════════════════════════════
const MONITOR_ALARM = 'financeecom-monitor';
const MONITOR_DEFAULTS = { monitorEnabled: true, batchSize: 5, maxTabs: 3, tabTimeoutMs: 25000 };
let _monitorRunning = false; // trava anti-reentrância dentro do mesmo SW vivo

async function apiBase() {
  const r = await chrome.storage.local.get(['apiUrl']);
  return (r.apiUrl && r.apiUrl.trim()) || 'https://multimixvendas.duckdns.org';
}
async function monitorCfg() {
  const r = await chrome.storage.local.get(Object.keys(MONITOR_DEFAULTS));
  return { ...MONITOR_DEFAULTS, ...r };
}

// Garante o alarm criado (idempotente) — chamado no install, no startup e a
// cada load do SW (que o Chrome recria sob demanda).
async function ensureAlarm() {
  const a = await chrome.alarms.get(MONITOR_ALARM);
  if (!a) chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 15, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALARM) runMonitorCycle().catch((e) => console.error('[SW] ciclo monitor erro:', e));
});

// Abre o anúncio numa aba oculta, espera carregar, pede a captura ao content
// script, devolve o rawData. Sempre fecha a aba no fim (mesmo em erro/timeout).
async function captureInHiddenTab(url, timeoutMs) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId, timeoutMs);
    // pequena folga extra pro JS do ML pintar o preço
    await new Promise((r) => setTimeout(r, 1200));
    const resp = await sendMessageWithTimeout(tabId, { action: 'auto_capture' }, timeoutMs);
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'sem captura');
    return resp.rawData;
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); reject(new Error('timeout carregando aba')); }, timeoutMs);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(to); chrome.tabs.onUpdated.removeListener(onUpd); resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

function sendMessageWithTimeout(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout aguardando content' }); } }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (done) return;
      done = true; clearTimeout(to);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

// Processa uma lista de itens com no máximo `maxTabs` abas ao mesmo tempo
// (pool simples). Cada item: abre/lê/fecha aba → POST no backend.
async function processQueue(itens, cfg, base) {
  let idx = 0, ok = 0, fail = 0;
  async function worker() {
    while (idx < itens.length) {
      const it = itens[idx++];
      const url = it.url || (it.ml_id ? `https://produto.mercadolivre.com.br/${it.ml_id}` : null);
      if (!url) { fail++; continue; }
      try {
        const rawData = await captureInHiddenTab(url, cfg.tabTimeoutMs);
        const res = await fetchWithRetry(`${base}/extension/monitoramento`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketplace: 'mercadolivre', rawData }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ok++;
      } catch (e) { fail++; console.warn('[SW] monitor falhou', it.ml_id, e.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.maxTabs, itens.length) }, worker));
  return { ok, fail };
}

async function runMonitorCycle() {
  if (_monitorRunning) return;
  const cfg = await monitorCfg();
  if (!cfg.monitorEnabled) return;
  _monitorRunning = true;
  try {
    const base = await apiBase();
    const res = await fetchWithRetry(`${base}/extension/monitoramento/proximos?limit=${cfg.batchSize}`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} em /proximos`);
    const { itens = [] } = await res.json();
    if (!itens.length) { await chrome.storage.local.set({ monitorLast: { at: Date.now(), ok: 0, fail: 0, empty: true } }); return; }
    const r = await processQueue(itens, cfg, base);
    await chrome.storage.local.set({ monitorLast: { at: Date.now(), ok: r.ok, fail: r.fail } });
    console.log('[SW] ciclo monitor:', r);
  } catch (e) {
    console.error('[SW] runMonitorCycle:', e.message);
  } finally {
    _monitorRunning = false;
  }
}

// Sincronização manual pelo popup ("Sincronizar Agora").
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'run_monitor_now') {
    runMonitorCycle().then(() => sendResponse({ started: true })).catch(() => sendResponse({ started: false }));
    return true;
  }
  if (request.action === 'get_monitor_status') {
    chrome.storage.local.get(['monitorLast', 'monitorEnabled']).then((r) => sendResponse(r));
    return true;
  }
});
