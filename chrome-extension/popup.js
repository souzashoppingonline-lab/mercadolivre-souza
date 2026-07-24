document.addEventListener('DOMContentLoaded', async () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const collectBtn = document.getElementById('collectBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusDiv = document.getElementById('status');
  const dataPreviewDiv = document.getElementById('dataPreview');

  // Restore saved API URL
  chrome.storage.local.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
    }
  });

  // Save API URL when input changes
  apiUrlInput.addEventListener('change', () => {
    chrome.storage.local.set({ apiUrl: apiUrlInput.value });
  });

  // Collect data button
  collectBtn.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim();

    if (!apiUrl) {
      showStatus('Por favor, configure a URL da API', 'error');
      return;
    }

    showStatus('Coletando dados...', 'loading');
    collectBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Inject content script and get data
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: extractPageData,
      });

      const data = results[0]?.result;

      if (!data) {
        showStatus('Não foi possível extrair dados da página', 'error');
        collectBtn.disabled = false;
        return;
      }

      // Send data to API
      const response = await fetch(`${apiUrl}/marketplace-events/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: 'mercadolivre',
          pageUrl: tab.url,
          ...data,
          collectedAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      showStatus('✓ Dados coletados e enviados com sucesso!', 'success');
      displayPreview(data);
    } catch (error) {
      console.error('Erro na coleta:', error);
      showStatus(`Erro: ${error.message}`, 'error');
    } finally {
      collectBtn.disabled = false;
    }
  });

  // Clear data preview
  clearBtn.addEventListener('click', () => {
    dataPreviewDiv.style.display = 'none';
    statusDiv.style.display = 'none';
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
  }

  function displayPreview(data) {
    let html = '';

    if (data.title) {
      html += `<div class="data-item"><div class="data-label">📦 Título</div><div class="data-value">${escapeHtml(data.title)}</div></div>`;
    }

    if (data.salesCount) {
      html += `<div class="data-item"><div class="data-label">💰 Vendas</div><div class="data-value">${data.salesCount}</div></div>`;
    }

    if (data.price) {
      html += `<div class="data-item"><div class="data-label">💵 Preço</div><div class="data-value">R$ ${data.price}</div></div>`;
    }

    if (data.commentsCount) {
      html += `<div class="data-item"><div class="data-label">💬 Comentários</div><div class="data-value">${data.commentsCount}</div></div>`;
    }

    if (data.questionsCount) {
      html += `<div class="data-item"><div class="data-label">❓ Perguntas</div><div class="data-value">${data.questionsCount}</div></div>`;
    }

    if (data.rating) {
      html += `<div class="data-item"><div class="data-label">⭐ Avaliação</div><div class="data-value">${data.rating}</div></div>`;
    }

    if (data.comments && data.comments.length > 0) {
      html += `<div class="data-item"><div class="data-label">📝 Alguns comentários</div><div class="data-value">${data.comments.slice(0, 3).map(c => `• ${escapeHtml(c)}`).join('<br>')}</div></div>`;
    }

    dataPreviewDiv.innerHTML = html;
    dataPreviewDiv.style.display = 'block';
  }

  function escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
});

// Function to extract data from Mercado Livre product page
function extractPageData() {
  const data = {
    title: null,
    price: null,
    salesCount: null,
    rating: null,
    commentsCount: null,
    questionsCount: null,
    comments: [],
  };

  try {
    // Extract title
    const titleEl = document.querySelector('h1') || document.querySelector('[class*="title"]');
    if (titleEl) {
      data.title = titleEl.textContent.trim();
    }

    // Extract price
    const priceEl = document.querySelector('[class*="price"]');
    if (priceEl) {
      const priceText = priceEl.textContent.trim().replace(/[^\d,]/g, '');
      data.price = priceText.replace(',', '.');
    }

    // Extract sales count (usually in format "XXX vendas")
    const pageText = document.body.innerText;
    const salesMatch = pageText.match(/(\d+)\s*vendas?/i);
    if (salesMatch) {
      data.salesCount = salesMatch[1];
    }

    // Extract rating
    const ratingEl = document.querySelector('[class*="rating"]') ||
                     document.querySelector('[class*="stars"]');
    if (ratingEl) {
      data.rating = ratingEl.textContent.trim();
    }

    // Count comments/reviews
    const commentEls = document.querySelectorAll('[class*="review"]');
    data.commentsCount = commentEls.length;

    // Extract sample comments
    commentEls.forEach((el, i) => {
      if (i < 5) {
        const text = el.textContent.trim();
        if (text.length > 0 && text.length < 500) {
          data.comments.push(text);
        }
      }
    });

    // Count questions (usually in a Q&A section)
    const questionEls = document.querySelectorAll('[class*="question"], [class*="qa"]');
    data.questionsCount = questionEls.length;

  } catch (error) {
    console.error('Erro ao extrair dados:', error);
  }

  return data;
}
