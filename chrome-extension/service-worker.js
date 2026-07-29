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
