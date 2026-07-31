// Service Worker do PWA — o mínimo pra instalar (ícone na tela inicial, abre
// sem barra do navegador) SEM comprometer a atualização dos dados.
//
// Regra de ouro: NUNCA cachear /api, /webhooks, /auth, /ws — são dados ao vivo
// (venda/estoque/margem). O SW só guarda a "casca" estática (HTML/CSS/JS) pra
// abrir offline; pra tudo é rede-primeiro, caindo pro cache só se a rede falhar.
const CACHE = 'ml-shell-v1';
const SHELL = ['/index.html', '/css/style.css', '/css/sidebar.css', '/css/cards.css',
  '/js/db.js', '/js/layout.js', '/js/sidebar.js', '/js/websocket.js', '/assets/logo.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return; // POST/PATCH nunca são cacheados
  // Dados ao vivo: rede pura, sem tocar no cache.
  if (/^\/(api|webhooks|auth|ws|print-agent|extension)/.test(url.pathname)) return;
  // Estático (navegação/CSS/JS): rede-primeiro, cache como rede de segurança offline.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
