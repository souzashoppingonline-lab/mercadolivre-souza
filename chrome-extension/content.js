// Content script v3 — super minimalista
// Injeta botão na página, clica = envia HTML bruto para backend

console.log('[extension] content.js carregado');

// Injetar botão flutuante na página
const button = document.createElement('button');
button.innerHTML = '📊 Enviar para Análise';
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
`;

button.onmouseover = () => {
  button.style.background = '#FFC107';
  button.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
};

button.onmouseout = () => {
  button.style.background = '#FFE600';
  button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
};

button.onclick = async () => {
  button.innerHTML = '⏳ Enviando...';
  button.disabled = true;

  try {
    // Recuperar API URL do storage
    const result = await chrome.storage.local.get(['apiUrl']);
    const apiUrl = result.apiUrl?.trim();

    if (!apiUrl) {
      alert('Configure a URL da API no popup da extensão');
      return;
    }

    // Enviar HTML bruto para backend
    const response = await fetch(`${apiUrl}/extension/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'mercadolivre',
        rawData: {
          url: window.location.href,
          html: document.body.innerHTML,
          pageText: document.body.innerText,
          collectedAt: new Date().toISOString(),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Erro ${response.status}`);
    }

    const result = await response.json();
    button.innerHTML = '✓ Enviado!';
    button.style.background = '#4CAF50';

    setTimeout(() => {
      button.innerHTML = '📊 Enviar para Análise';
      button.style.background = '#FFE600';
      button.disabled = false;
    }, 2000);
  } catch (error) {
    console.error('[extension] Erro:', error);
    alert(`Erro: ${error.message}`);
    button.innerHTML = '📊 Enviar para Análise';
    button.disabled = false;
  }
};

document.body.appendChild(button);
