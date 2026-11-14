import { api as defaultClient, type createApiClient } from './client';
import { unwrap } from './errors';

/**
 * Включена ли предзагрузка следующего трека сразу (`playback.prefetch_next`). Настройки не загрузились —
 * считаем включённой (значение по умолчанию на сервере).
 */
export async function loadPrefetchEnabled(
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<boolean> {
  try {
    const settings = unwrap(await client.GET('/api/settings')) as { playback?: { prefetch_next?: boolean } };
    return settings.playback?.prefetch_next ?? true;
  } catch {
    return true;
  }
}
