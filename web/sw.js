// Service worker: lets the planner and on-road companion open without signal.
// Strategy: API calls always go to the network. Pages, scripts and styles are
// fetched from the network first (so updates arrive immediately) and the
// cached copy is used only when the network is unavailable.
const CACHE = 'route-plus-v2';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'companion.html', 'assets/images/hero.jpg'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    try {
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    } catch {
      return (await cache.match(event.request)) || Response.error();
    }
  }));
});
