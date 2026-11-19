// При изменении файлов приложения увеличь номер версии — так iPhone подтянет обновление.
const CACHE = 'kak-davno-v8';
const FILES = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'supabase-config.js', 'cloud.js'];
const ASSETS = new Set(FILES.map(file => new URL(file, self.registration.scope).pathname));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('kak-davno-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Сначала сеть (чтобы обновления приходили сразу), без сети — из кэша.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Только файлы приложения. Сессии и ответы Supabase никогда не попадают в кэш.
  if (url.origin !== self.location.origin || !ASSETS.has(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy))); }
        return r;
      })
      .catch(async () => {
        const cached = await caches.match(e.request, { ignoreSearch: true });
        if (cached) return cached;
        if (e.request.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
        return Response.error();
      })
  );
});
