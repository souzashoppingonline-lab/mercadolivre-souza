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

// ── Notificação push (PWA "Dívidas do Dia") ─────────────────────────────────
// O servidor (worker.js, 07:00) manda {title, body, url, tag}; aqui só exibe.
// Tocar na notificação abre/foca a página da URL. Ver .claude/frontend.md.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '💸 Dívidas do Dia', {
    body: d.body || '',
    icon: '/assets/dividas-192.png',
    badge: '/assets/dividas-badge.png',
    tag: d.tag || 'dividas',
    renotify: true,
    vibrate: [80, 60, 80],
    data: { url: d.url || '/pages/financeiro-dividas-hoje.html' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || '/pages/financeiro-dividas-hoje.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abertas) => {
    const ja = abertas.find((c) => c.url.split('#')[0] === alvo);
    if (ja) return ja.focus().then((c) => c && c.navigate ? c.navigate(alvo) : c).catch(() => ja.focus());
    return self.clients.openWindow(alvo);
  }));
});

// O navegador às vezes troca a inscrição sozinho (expirou/renovou): reinscreve
// com a mesma chave e avisa o servidor, senão o push das 07:00 para de chegar.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const r = await fetch('/api/financeiro/push/chave', { credentials: 'same-origin' });
    const { publicKey } = await r.json();
    const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
    const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const key = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/financeiro/push/inscrever', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  })().catch(() => {}));
});

