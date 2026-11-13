// Кэш картинок на клиенте: обложки (Cover Art Archive / archive.org) и фото артистов (/api/artist-image/).
// Стратегия cache-first: повторно картинка с сети не грузится, пока запись жива в кэше.
const CACHE = 'nimbus-images-v1';
const MAX_ENTRIES = 2000;

function isImageRequest(request) {
  if (request.method !== 'GET' || request.destination !== 'image') return false;
  const url = new URL(request.url);
  return (
    url.hostname === 'coverartarchive.org' ||
    url.hostname.endsWith('archive.org') ||
    url.pathname.startsWith('/api/artist-image/')
  );
}

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map(k => cache.delete(k)));
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(names.filter(n => n.startsWith('nimbus-images-') && n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (!isImageRequest(request)) return;
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      // Кэшируем только успешные ответы (opaque от cross-origin <img> тоже годится); 404 «нет фото» не кэшируем.
      if (response.ok || response.type === 'opaque') {
        cache.put(request, response.clone()).then(() => trim(cache));
      }
      return response;
    }),
  );
});
