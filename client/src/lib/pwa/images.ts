import { IMAGE_CACHE } from '@/sw/cache';

/** Очищает кэш обложек и фото артистов (выход из учётной записи). Без Cache API — ничего не делает. */
export async function clearImageCache(
  cacheStorage: Pick<CacheStorage, 'delete'> | undefined = globalThis.caches,
): Promise<void> {
  try {
    await cacheStorage?.delete(IMAGE_CACHE);
  } catch {
    // Кэш — удобство.
  }
}
