document.addEventListener('DOMContentLoaded', async () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const collectBtn = document.getElementById('collectBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusDiv = document.getElementById('status');
  const dataPreviewDiv = document.getElementById('dataPreview');

  chrome.storage.local.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
    }
  });

  apiUrlInput.addEventListener('change', () => {
    chrome.storage.local.set({ apiUrl: apiUrlInput.value });
  });

  collectBtn.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim();
    if (!apiUrl) {
      showStatus('Por favor, configure a URL da API', 'error');
      return;
    }

    showStatus('Coletando dados brutos...', 'loading');
    collectBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Executar content.js para coletar dados BRUTOS
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          return {
            url: window.location.href,
            pageText: document.body.innerText,
            titleHtml: document.querySelector('h1')?.outerHTML || null,
            priceHtml: document.querySelector('[class*="price"]')?.outerHTML || null,
            ratingHtml: document.querySelector('[class*="rating"]')?.outerHTML || null,
            jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
              .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
              .filter(Boolean),
            domSnapshot: {
              priceSection: document.querySelector('[class*="price"]')?.innerHTML?.substring(0, 2000) || null,
              ratingSection: document.querySelector('[class*="rating"]')?.innerHTML?.substring(0, 1000) || null,
              reviewsSection: document.querySelector('[class*="review"]')?.innerHTML?.substring(0, 2000) || null,
            },
            collectedAt: new Date().toISOString(),
          };
        },
      });

      const rawData = results[0]?.result;
      if (!rawData) {
        showStatus('Não foi possível extrair dados da página', 'error');
        collectBtn.disabled = false;
        return;
      }

      // Enviar dados BRUTOS para backend processar
      const baseUrl = apiUrl.replace(/\/api\/?$/, '');
      const response = await fetch(`${baseUrl}/extension/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: 'mercadolivre',
          rawData: rawData,
          collectedAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      showStatus('✓ Dados coletados e processados!', 'success');
      displayDebugPanel(result.extracted, result.debug);
    } catch (error) {
      console.error('Erro:', error);
      showStatus(`Erro: ${error.message}`, 'error');
    } finally {
      collectBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', () => {
    dataPreviewDiv.style.display = 'none';
    statusDiv.style.display = 'none';
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
  }

  function displayDebugPanel(extracted, debug) {
    let html = '<div class="debug-panel">';
    html += '<h3>📊 Status de Extração</h3>';

    const fields = [
      { name: 'Título', value: extracted?.title },
      { name: 'Preço Normal', value: extracted?.price?.normal },
      { name: 'Preço Promoção', value: extracted?.price?.promotion },
      { name: 'Vendas', value: extracted?.salesCount?.numero },
      { name: 'Avaliação', value: extracted?.rating?.nota },
      { name: 'Comentários (count)', value: extracted?.commentsCount },
      { name: 'Perguntas (count)', value: extracted?.questionsCount },
      { name: 'Comentários (conteúdo)', value: extracted?.comments?.length > 0 },
      { name: 'Fotos', value: extracted?.images?.length > 0 },
      { name: 'Seller', value: extracted?.seller },
    ];

    fields.forEach(field => {
      const icon = field.value ? '✓' : '✗';
      const status = field.value ? 'success' : 'fail';
      html += `<div class="debug-item ${status}">${icon} ${field.name}</div>`;
    });

    html += '</div><div class="data-sample">';
    if (extracted?.title) {
      html += `<div><strong>📦 Título:</strong> ${escapeHtml(extracted.title)}</div>`;
    }
    if (extracted?.price?.promotion) {
      html += `<div><strong>💵 Preço Promoção:</strong> R$ ${extracted.price.promotion}</div>`;
    }
    if (extracted?.rating?.nota) {
      html += `<div><strong>⭐ Avaliação:</strong> ${extracted.rating.nota} (${extracted.rating.opinioes} opiniões)</div>`;
    }
    if (extracted?.comments?.length > 0) {
      html += `<div><strong>📝 Comentários (${extracted.comments.length}):</strong><br>`;
      html += extracted.comments.slice(0, 3).map(c => `• ${escapeHtml(c.substring(0, 100))}`).join('<br>');
      html += '</div>';
    }
    html += '</div>';

    dataPreviewDiv.innerHTML = html;
    dataPreviewDiv.style.display = 'block';
  }

  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
});
