import { isDictionaryPath } from '@/sw/classify';
import { RUNTIME_CACHE } from '@/sw/cache';

type PerfLike = { getEntriesByType(type: string): readonly { name: string }[] };
type CachesLike = { open(name: string): Promise<{ add(url: string): Promise<void> }> };

/**
 * Словарь выбранного языка загружается до того, как service worker берёт страницу под контроль, и в кэш не попадает.
 * После активации дописываем уже загруженные чанки словарей в runtime-кэш — иначе офлайн-старт был бы на английском.
 */
export async function warmDictionaryCache(
  perf: PerfLike | undefined = globalThis.performance,
  cacheStorage: CachesLike | undefined = globalThis.caches,
  origin: string = globalThis.location?.origin ?? '',
): Promise<number> {
  if (!perf || !cacheStorage) return 0;
  const urls = perf
    .getEntriesByType('resource')
    .map(e => e.name)
    .filter(name => {
      try {
        const url = new URL(name);
        return url.origin === origin && isDictionaryPath(url.pathname);
      } catch {
        return false;
      }
    });
  if (urls.length === 0) return 0;
  try {
    const cache = await cacheStorage.open(RUNTIME_CACHE);
    await Promise.all(urls.map(u => cache.add(u)));
    return urls.length;
  } catch {
    return 0;
  }
}
