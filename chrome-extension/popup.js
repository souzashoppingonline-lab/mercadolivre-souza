// Popup v3 — super minimalista, só salva URL da API

document.addEventListener('DOMContentLoaded', () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  // Restaurar URL salva
  chrome.storage.local.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
    }
  });

  // Salvar URL
  saveBtn.addEventListener('click', () => {
    const apiUrl = apiUrlInput.value.trim();

    if (!apiUrl) {
      statusDiv.textContent = 'Digite a URL da API';
      statusDiv.className = 'status error';
      statusDiv.style.display = 'block';
      return;
    }

    chrome.storage.local.set({ apiUrl }, () => {
      statusDiv.textContent = '✓ URL salva!';
      statusDiv.className = 'status success';
      statusDiv.style.display = 'block';

      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 2000);
    });
  });

  // Clear
  document.getElementById('clearBtn').addEventListener('click', () => {
    chrome.storage.local.remove(['apiUrl'], () => {
      apiUrlInput.value = '';
      statusDiv.textContent = 'Limpado';
      statusDiv.className = 'status';
      statusDiv.style.display = 'block';

      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 1500);
    });
  });
});
