/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { cacheFirst, IMAGE_CACHE, MAX_IMAGES, RUNTIME_CACHE, staleImageCaches, staleWhileRevalidate } from './cache';
import { classifyRequest } from './classify';

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
      event.respondWith(caches.open(IMAGE_CACHE).then(cache => cacheFirst(request, cache, fetch, MAX_IMAGES, after)));
      break;
    case 'dictionary':
      event.respondWith(caches.open(RUNTIME_CACHE).then(cache => staleWhileRevalidate(request, cache, fetch, after)));
      break;
    case 'passthrough':
      break;
  }
});
