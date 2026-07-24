// Service Worker for FinanceEcom Monitor Chrome Extension
console.log('FinanceEcom Monitor background service worker started');

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && (tab.url.includes('mercadolivre.com.br') || tab.url.includes('produto.mercadolivre'))) {
    // Open popup by default
    chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' });
  }
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageData') {
    // Forward to content script if needed
    sendResponse({ status: 'received' });
  }
});
