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

/** Сколько живёт запомненный 404 «нет фото» (дальше — снова спрашиваем бэкенд: фото могло появиться). */
export const NEGATIVE_TTL_MS = 24 * 3600 * 1000;
/** Метка времени записи 404 в кэше (мс), не заголовок протокола — воркер читает её сам. */
const NEGATIVE_AT = 'x-nimbus-negative-at';

/** Запись кэша — запомненный «нет фото», а не картинка. */
export const isNegativeEntry = (response: Response): boolean => response.headers.has(NEGATIVE_AT);

const negativeFresh = (response: Response, now: number): boolean => {
  const at = Number(response.headers.get(NEGATIVE_AT));
  return Number.isFinite(at) && now - at < NEGATIVE_TTL_MS;
};

/** 404 с кодом `no_image` (бэкенд: у артиста нет фото) — единственный ответ об ошибке, который запоминается. */
async function isNoImage(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    return ((await response.clone().json()) as { code?: unknown } | null)?.code === 'no_image';
  } catch {
    return false;
  }
}

export type CacheFirstOptions = {
  /** Предел числа записей (вытесняются самые старые); без него записи хранятся бессрочно. */
  max?: number;
  /** Запоминать 404 `no_image` на сутки (фото артистов вне библиотеки, у которых нет строки в store). */
  negative?: boolean;
  now?: () => number;
};

/**
 * Cache-first. Запись идёт в фоне (`after` получает промис — воркер держит себя живым через `waitUntil`).
 */
export async function cacheFirst(
  request: Request,
  cache: CacheLike,
  fetcher: Fetcher,
  options: CacheFirstOptions = {},
  after: (done: Promise<unknown>) => void = () => undefined,
): Promise<Response> {
  const { max = Number.POSITIVE_INFINITY, negative = false, now = Date.now } = options;
  const hit = await cache.match(request, MATCH);
  if (hit) {
    if (!isNegativeEntry(hit)) return hit;
    if (negativeFresh(hit, now())) return hit;
    // Срок «нет фото» вышел: запись удаляется, спрашиваем бэкенд заново.
    await cache.delete(request);
  }
  const response = await fetcher(request);
  if (isCacheable(response)) {
    after(cache.put(request, response.clone()).then(() => (Number.isFinite(max) ? trimCache(cache, max) : undefined)));
  } else if (negative && (await isNoImage(response))) {
    const body = await response.clone().text();
    const headers = new Headers(response.headers);
    headers.set(NEGATIVE_AT, String(now()));
    after(cache.put(request, new Response(body, { headers, status: 404, statusText: response.statusText })));
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
