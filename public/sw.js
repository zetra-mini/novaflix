// NovaFlix PWA Service Worker
const CACHE_NAME = 'novaflix-cache-v7';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/player.js',
  '/m3u-parser.js',
  '/settings-manager.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Falha ao pré-carregar alguns assets estáticos:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NUNCA interceptar fluxos de vídeo, proxies de stream, chamadas de API dinâmicas ou heartbeats
  if (
    url.pathname.includes('/api/stream') ||
    url.pathname.includes('/api/heartbeat') ||
    url.pathname.includes('/api/netflix/') ||
    url.pathname.includes('/api/admin/') ||
    url.pathname.endsWith('.ts') ||
    url.pathname.endsWith('.m3u8') ||
    url.pathname.endsWith('.mp4') ||
    event.request.method !== 'GET'
  ) {
    return; // Passa direto para a rede
  }

  // Network-First para assets da aplicação
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
