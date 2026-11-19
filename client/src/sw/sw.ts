/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { cacheFirst, IMAGE_CACHE, RUNTIME_CACHE, staleImageCaches, staleWhileRevalidate } from './cache';
import { classifyRequest } from './classify';
import { isArtistPhotoPath } from '@/lib/platform/urls';

declare const self: ServiceWorkerGlobalScope;

// Оболочка: `index.html`, чанки, шрифты, иконки — в precache (манифест подставляет vite-plugin-pwa).
// `directoryIndex: null`: навигацию (в том числе `/`) отвечает обработчик ниже, а не маршрут precache.
// Типы Workbox не допускают `null`, хотя именно он отключает directoryIndex.
precacheAndRoute(self.__WB_MANIFEST, { directoryIndex: null as unknown as undefined });
cleanupOutdatedCaches();

// Новая версия ждёт, пока пользователь нажмёт «Обновить» (клиент шлёт SKIP_WAITING).
self.addEventListener('message', event => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(staleImageCaches(names).map(n => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Загрузка изображения. Обложки с чужого origin запрашиваем в режиме CORS (Cover Art Archive и archive.org отдают
 * `Access-Control-Allow-Origin: *` по всей цепочке редиректов): ответ читаем, статус виден — в кэш попадает только успех.
 * Не вышло (нет CORS, сеть) — обычный запрос `<img>`: покажется, но не закэшируется.
 */
function fetchImage(request: Request): Promise<Response> {
  if (new URL(request.url).origin === self.location.origin) return fetch(request);
  return fetch(request.url, { credentials: 'omit', mode: 'cors' }).catch(() => fetch(request));
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const kind = classifyRequest(
    {
      destination: request.destination,
      method: request.method,
      mode: request.mode,
      range: request.headers.has('range'),
      url: request.url,
    },
    self.location.origin,
  );
  const after = (done: Promise<unknown>) => event.waitUntil(done.catch(() => undefined));
  switch (kind) {
    case 'shell':
      event.respondWith(matchPrecache('index.html').then(hit => hit ?? fetch(request)));
      break;
    case 'image':
      event.respondWith(
        caches.open(IMAGE_CACHE).then(cache => {
          // 404 «нет фото» фото артиста запоминается на сутки: аватар без фото не бьёт в сеть при каждом показе.
          const negative = isArtistPhotoPath(new URL(request.url).pathname);
          return cacheFirst(request, cache, fetchImage, { negative }, after);
        }),
      );
      break;
    case 'dictionary':
      event.respondWith(caches.open(RUNTIME_CACHE).then(cache => staleWhileRevalidate(request, cache, fetch, after)));
      break;
    case 'passthrough':
      break;
  }
});
