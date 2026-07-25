// Popup Script v1 — configuração da extensão

document.addEventListener('DOMContentLoaded', () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const saveBtn = document.getElementById('saveBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusDiv = document.getElementById('status');

  console.log('[popup] Popup carregado');

  // Restaurar URL salva
  chrome.storage.local.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
      console.log('[popup] URL restaurada:', result.apiUrl);
    }
  });

  // Salvar URL
  saveBtn.addEventListener('click', () => {
    const apiUrl = apiUrlInput.value.trim();

    if (!apiUrl) {
      showStatus('Digite a URL da API', 'error');
      return;
    }

    // Validar URL básica
    try {
      new URL(apiUrl);
    } catch (e) {
      showStatus('URL inválida', 'error');
      return;
    }

    chrome.storage.local.set({ apiUrl }, () => {
      console.log('[popup] URL salva:', apiUrl);
      showStatus('✓ URL salva com sucesso!', 'success');
    });
  });

  // Limpar dados
  clearBtn.addEventListener('click', () => {
    chrome.storage.local.remove(['apiUrl'], () => {
      apiUrlInput.value = '';
      console.log('[popup] Dados limpos');
      showStatus('Dados removidos', 'success');
    });
  });

  // Salvar quando Enter for pressionado
  apiUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveBtn.click();
    }
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
    statusDiv.style.display = 'block';

    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});
