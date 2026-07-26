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

  // Mostrar o produto ativo (a extensão NUNCA pergunta — lê do servidor).
  const DEFAULT_API = 'https://multimixvendas.duckdns.org';
  function loadAtivo() {
    chrome.storage.local.get(['apiUrl'], (result) => {
      const api = (result.apiUrl && result.apiUrl.trim()) || DEFAULT_API;
      const box = document.getElementById('ativoBox');
      if (!box) return;
      fetch(`${api}/extension/produto-ativo`)
        .then((r) => r.json())
        .then(({ produto }) => {
          box.innerHTML = produto
            ? `<b style="color:#1e7e34">${String(produto.produto || '').replace(/</g, '&lt;')}</b><br><span style="color:#888">Os anúncios coletados vão para este produto.</span>`
            : `<span style="color:#c62828">Nenhum produto em análise.</span><br><span style="color:#888">Ative a coleta de um produto no dashboard.</span>`;
        })
        .catch(() => { box.innerHTML = '<span style="color:#c62828">Não foi possível consultar o servidor.</span>'; });
    });
  }
  loadAtivo();
  document.getElementById('saveBtn')?.addEventListener('click', () => setTimeout(loadAtivo, 300));

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
