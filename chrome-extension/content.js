// Content Script v1 — coleta dados brutos da página do Mercado Livre

console.log('[content] Content Script carregado');

// Esperar um pouco para a página renderizar (React hydration)
setTimeout(() => {
  injectButton();
}, 1000);

function injectButton() {
  // Verificar se o botão já não existe
  if (document.getElementById('finance-ecom-button')) {
    console.log('[content] Botão já existe');
    return;
  }

  // Criar botão flutuante
  const button = document.createElement('button');
  button.id = 'finance-ecom-button';
  button.innerHTML = '📊 Coletar Dados';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    padding: 12px 16px;
    background: #FFE600;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    transition: all 0.3s ease;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  // Hover effect
  button.onmouseover = () => {
    button.style.background = '#FFC107';
    button.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
  };

  button.onmouseout = () => {
    button.style.background = '#FFE600';
    button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  };

  // Evento de clique
  button.onclick = () => {
    collectAndSend(button);
  };

  // Injetar na página
  if (document.body) {
    document.body.appendChild(button);
    console.log('[content] Botão injetado com sucesso');
  } else {
    console.warn('[content] document.body não disponível');
  }
}

function collectAndSend(button) {
  const originalText = button.innerHTML;
  button.innerHTML = '⏳ Enviando...';
  button.disabled = true;

  try {
    // Coletar dados brutos. Enviamos pageText (texto) + jsonLd (structured data
    // p/ imagens) — NÃO o innerHTML inteiro (é enorme e o extrator do servidor
    // não usa; mandar estouraria o limite do body).
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => { try { return JSON.parse(s.textContent); } catch (e) { return null; } })
      .filter(Boolean).flat();
    const rawData = {
      url: window.location.href,
      pageText: document.body.innerText,
      title: document.title,
      jsonLd,
      collectedAt: new Date().toISOString(),
    };

    console.log('[content] Dados coletados, enviando ao Service Worker...');

    // Enviar ao Service Worker
    chrome.runtime.sendMessage(
      {
        action: 'collect_data',
        data: rawData,
      },
      (response) => {
        handleResponse(response, button, originalText);
      }
    );
  } catch (error) {
    console.error('[content] Erro ao coletar dados:', error);
    showMessage(button, '❌ Erro ao coletar', 'error', originalText);
  }
}

function handleResponse(response, button, originalText) {
  if (chrome.runtime.lastError) {
    console.error('[content] Erro de comunicação:', chrome.runtime.lastError);
    showMessage(button, '❌ Erro: ' + chrome.runtime.lastError.message, 'error', originalText);
    return;
  }

  if (!response) {
    console.error('[content] Sem resposta do Service Worker');
    showMessage(button, '❌ Sem resposta do serviço', 'error', originalText);
    return;
  }

  if (response.success) {
    console.log('[content] Sucesso:', response.data);
    showMessage(button, '✓ Dados enviados!', 'success', originalText);
  } else {
    console.error('[content] Erro na resposta:', response.error);
    showMessage(button, '❌ ' + response.error, 'error', originalText);
  }
}

function showMessage(button, message, type, originalText) {
  button.innerHTML = message;

  if (type === 'success') {
    button.style.background = '#4CAF50';
  } else if (type === 'error') {
    button.style.background = '#f44336';
  }

  setTimeout(() => {
    button.innerHTML = originalText;
    button.style.background = '#FFE600';
    button.disabled = false;
  }, 3000);
}
