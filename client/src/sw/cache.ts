// Кэши service worker как чистые функции над минимальным интерфейсом `CacheLike`.

export const IMAGE_CACHE = 'nimbus-images-v3';
export const RUNTIME_CACHE = 'nimbus-runtime-v1';
export type CacheLike = {
  match(request: Request, options?: { ignoreVary?: boolean }): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
};

/** `Vary: Origin` у сервера (vite, CDN) иначе разводит запрос модуля (с `Origin`) и запись из `cache.add` (без него). */
const MATCH = { ignoreVary: true };

export type Fetcher = (request: Request) => Promise<Response>;

/**
 * Ответ годится для кэша: только успешный и читаемый. Непрозрачный (`opaque`) не берём: по нему не видно статус, а записи
 * хранятся навсегда — случайная ошибка сервера осталась бы навечно. 404 «нет фото» — тоже нет.
 */
export const isCacheable = (response: Response): boolean => response.ok;

/** Удаляет самые старые записи сверх лимита (порядок `keys()` — порядок добавления). */
export async function trimCache(cache: CacheLike, max: number): Promise<void> {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(k => cache.delete(k)));
}

/**
 * Cache-first. Запись идёт в фоне (`after` получает промис — воркер держит себя живым через `waitUntil`).
 * `max` — необязательный предел числа записей (вытесняются самые старые); без него записи хранятся бессрочно.
 */
export async function cacheFirst(
  request: Request,
  cache: CacheLike,
  fetcher: Fetcher,
  max: number = Number.POSITIVE_INFINITY,
  after: (done: Promise<unknown>) => void = () => undefined,
): Promise<Response> {
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const response = await fetcher(request);
  if (isCacheable(response)) {
    after(cache.put(request, response.clone()).then(() => (Number.isFinite(max) ? trimCache(cache, max) : undefined)));
  }
  return response;
}

/** Stale-while-revalidate: отдаёт кэш сразу, обновляет в фоне; без кэша ждёт сеть. */
export async function staleWhileRevalidate(
  request: Request,
  cache: CacheLike,
  fetcher: Fetcher,
  after: (done: Promise<unknown>) => void = () => undefined,
): Promise<Response> {
  const hit = await cache.match(request, MATCH);
  const refresh = fetcher(request).then(async response => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });
  if (hit) {
    after(refresh.catch(() => undefined));
    return hit;
  }
  return refresh;
}

/** Кэши изображений прежних версий (включая `nimbus-images-v1` старого `web/public/sw.js`) — на удаление. */
export function staleImageCaches(names: readonly string[]): string[] {
  return names.filter(n => n.startsWith('nimbus-images-') && n !== IMAGE_CACHE);
}
